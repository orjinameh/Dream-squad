import { createPublicClient, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { binarySettlementAbi } from "@somnia-chain/markets-sdk";
import { EC_ADDRESSES, EC_CHAIN, ecHttpTransport } from "./config";
import { ecExchange, quoteStake, readArenaSettlement, type ArenaRef } from "./executor";

/**
 * REAL DreamDEX stake placement for DreamDuel rounds, using the SDK's own
 * trader exactly as the developer resource documents:
 *
 *   const trader = client.createTrader({ privateKey });
 *   await trader.placeOrder({ pool, side: "BUY_YES", price, quantity,
 *                              orderType: ORDER_MARKET });
 *
 * A BUY escrows collateral directly from the signer (the trader auto-approves
 * the POOL for the cost — no vault deposit, no mintSet needed to BUY). The
 * round's combat result comes from the market's real protocol resolution
 * (winningOutcome 0=Up/1=Down); a won stake redeems 1:1 via
 * `trader.redeem({ market, amount, outcomeIdx })`.
 */

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const ORDER_MARKET = 2; // IOC — fill what crosses now, cancel the remainder
const ORDER_MAKER = 3; // PostOnly — must rest, never takes
const PAIR_PRICE = 500000n; // 0.5 — mint-a-pair leg price (player side + counter side)
const OUTCOME_UP = 0; // market winningOutcome: 0 = Up/YES
const OUTCOME_DOWN = 1; // 1 = Down/NO

/**
 * Order `expireTimestampNs`: unix ns, in the future, never past the window's own
 * expiry (the pool rejects 0/past with OrderAlreadyExpired). This is the docs'
 * dead-man's switch — a stuck bot's orders age off the book on their own.
 * Capped ~1min before the window closes so near-close round stakes don't revert.
 */
function orderExpiryNs(arena: ArenaRef): bigint {
  const capEpoch = Math.min(Math.floor(Date.now() / 1000) + 900, arena.expiry - 60);
  return BigInt(capEpoch) * 1_000_000_000n;
}

let _publicClient: ReturnType<typeof createPublicClient> | null = null;

export function publicClient() {
  if (_publicClient) return _publicClient;
  _publicClient = createPublicClient({ chain: EC_CHAIN, transport: ecHttpTransport() });
  return _publicClient;
}

/**
 * Place the player's REAL round stake: a market (IOC) buy of the predicted
 * outcome token on the round's arena window, sized to ~`stakeRaw` collateral,
 * signed by the operator. A buy escrows collateral directly — the trader
 * approves the pool for the cost transparently.
 *
 * Returns { txHash, error? }. Never throws: a failed stake must not fail the
 * match — the round still resolves off the real protocol result.
 */
export async function stakePlayerRoundOnDreamDEX(
  arena: ArenaRef,
  player: string,
  prediction: "UP" | "DOWN",
  stakeRaw: bigint,
  playerKey?: `0x${string}`,
): Promise<{ txHash: string | null; error?: string; costRaw?: bigint; filledQuantity?: bigint }> {
  if (process.env.DREAMDUEL_FAST_ROUNDS === "1") return { txHash: null };
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) return { txHash: null, error: "OPERATOR_PRIVATE_KEY not set" };

  const trader = ecExchange().client.createTrader({ privateKey: pk as `0x${string}` });
  const side = prediction === "UP" ? "BUY_YES" : "BUY_NO";
  const counterSide = prediction === "UP" ? "BUY_NO" : "BUY_YES";
  const takerKey = playerKey ?? (pk as `0x${string}`);

  // 1) Prefer organic liquidity: (a) a two-sided quoted IOC sized off the book,
  //    else (b) a plain mid-priced IOC that price-improves off any real ask/bid
  //    (near-close windows carry one-sided resters). Only a fill counts.
  const wholeSets = stakeRaw > 0n ? stakeRaw : 1_000_000n;
  const quote = await quoteStake(arena, prediction, stakeRaw).catch(() => null);
  const quoteAttempt = quote
    ? await placePlayerTakerFiltered(takerKey, arena, side, quote.price, quote.quantity)
    : null;
  if (quoteAttempt) return quoteAttempt;
  const freeAttempt = await placePlayerTakerFiltered(takerKey, arena, side, PAIR_PRICE, wholeSets);
  if (freeAttempt) return freeAttempt;

  // 2) No fillable book → the house PRICES the round itself with a mint-a-pair:
  //    rest the player's side as a PostOnly BUY, then IOC the counter-side BUY
  //    at the same price. Two opposite-side BUYs cross with NO seller — the pool
  //    mints a fresh Up/Down pair from their combined collateral — so the
  //    player's predicted outcome is ALWAYS a real on-chain position, even on an
  //    empty book, with a single (whitelisted) wallet (verified live: the pool
  //    does NOT treat a same-wallet BUY_YES×BUY_NO cross as a self-match).
  //    `playerKey` is honored when given (player wallet holds the tokens), else
  //    the operator custodies both legs.
  try {
    const pool = arena.pool as `0x${string}`;

    // Player's side first as a maker. If it crosses a real resting order the
    // position is even cheaper; if the 0.5 leg would cross a THICK book, step
    // the price down so it still rests (guaranteed fill beats best price here).
    let legPrice = PAIR_PRICE;
    let maker: Awaited<ReturnType<typeof trader.placeOrder>> | null = null;
    for (const attemptPrice of [PAIR_PRICE, 250000n, 100000n]) {
      try {
        maker = await trader.placeOrder({
          pool,
          side,
          price: attemptPrice,
          quantity: wholeSets,
          orderType: ORDER_MAKER, // PostOnly — must rest, never takes
          expireTimestampNs: orderExpiryNs(arena),
        });
        legPrice = attemptPrice;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("PostOnlyWouldCross")) throw err;
      }
    }
    if (!maker) throw new Error("PostOnly would cross at every leg price");

    // Counter side crosses it (or the book) with IOC — mint-a-pair, real fill.
    const fillRes = await placePlayerTaker(takerKey, arena, counterSide, legPrice, wholeSets);
    if (!fillRes.txHash) {
      return { ...fillRes, error: `mint-a-pair maker tx=${maker.hash} then ${fillRes.error ?? "no fill"}` };
    }
    // The PLAYER's leg is the maker: escrow at the leg price (BUY_YES pays
    // `legPrice`, BUY_NO pays `ONE - legPrice` per whole set).
    const playerCost = side === "BUY_YES" ? (legPrice * wholeSets) / 1_000_000n : ((1_000_000n - legPrice) * wholeSets) / 1_000_000n;
    return {
      txHash: maker.hash,
      costRaw: playerCost,
      filledQuantity: wholeSets,
      error: undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { txHash: null, error: msg.slice(0, 160) };
  }
}

/**
 * Mint testnet tUSDC on demand from the collateral token's on-chain faucet
 * (default 10,000 whole tUSDC). Lets the house fund its counter-side makers and
 * lets testnet players fund their stakes without the Telegram faucet. No-op when
 * the signer already holds `amount`.
 */
export async function faucetCollateral(
  key?: `0x${string}`,
  amount?: bigint,
): Promise<{ txHash: string | null; error?: string }> {
  const pk = key ?? process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) return { txHash: null, error: "key not set" };
  try {
    const trader = ecExchange().client.createTrader({ privateKey: pk as `0x${string}` });
    const fac = await trader.faucet({ ...(amount ? { amount } : {}) } as never);
    return { txHash: fac.hash };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { txHash: null, error: msg.slice(0, 160) };
  }
}

/** Place the player's organic leg but ONLY accept it if it actually filled. */
async function placePlayerTakerFiltered(
  signerKey: `0x${string}`,
  arena: ArenaRef,
  side: "BUY_YES" | "BUY_NO",
  price: bigint,
  quantity: bigint,
): Promise<{ txHash: string; costRaw: bigint; filledQuantity: bigint } | null> {
  const res = await placePlayerTaker(signerKey, arena, side, price, quantity);
  if (res.txHash && (res.filledQuantity ?? 0n) > 0n) {
    return { txHash: res.txHash, costRaw: res.costRaw ?? 0n, filledQuantity: res.filledQuantity ?? 0n };
  }
  return null;
}

/** Single IOC (market) buy for the player; reports the actual crossed fills. */
async function placePlayerTaker(
  signerKey: `0x${string}`,
  arena: ArenaRef,
  side: "BUY_YES" | "BUY_NO",
  price: bigint,
  quantity: bigint,
): Promise<{ txHash: string | null; error?: string; costRaw?: bigint; filledQuantity?: bigint }> {
  const trader = ecExchange().client.createTrader({ privateKey: signerKey });
  try {
    const res = await trader.placeOrder({
      pool: arena.pool as `0x${string}`,
      side,
      price,
      quantity,
      orderType: ORDER_MARKET,
      autoApprove: true,
      expireTimestampNs: orderExpiryNs(arena),
    });
    const fill = (res.fills ?? [])[0];
    if (!fill) return { txHash: null, error: "IOC found no crossing fill", filledQuantity: 0n, costRaw: 0n };
    const fillPrice = fill.fillPrice;
    const qty = fill.quantityFilled;
    // `price` is always in UP/YES terms; a NO buyer actually pays 1 - price.
    // costRaw is in raw collateral units (1e6 = 1 whole tUSDC on the 6-dp venue).
    const costRaw = side === "BUY_NO" ? ((1_000_000n - fillPrice) * qty) / 1_000_000n : (fillPrice * qty) / 1_000_000n;
    return {
      txHash: res.hash,
      costRaw,
      filledQuantity: qty,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { txHash: null, error: msg.slice(0, 160) };
  }
}

/**
 * The player's result for this market, from the protocol's own settlement:
 * did their predicted side win? `winningOutcomeRaw`: 0=Up/YES won, 1=Down/NO won.
 */
export async function readPlayerRoundResult(
  arena: ArenaRef,
  prediction: "UP" | "DOWN",
): Promise<{ won: boolean | null; winningOutcomeRaw: number | null; isVoided: boolean }> {
  const st = await readArenaSettlement(arena);
  if (!st.isResolved) return { won: null, winningOutcomeRaw: null, isVoided: false };
  if (st.isVoided) return { won: null, winningOutcomeRaw: null, isVoided: true };
  const upWon = st.winningOutcome === OUTCOME_UP;
  const won = prediction === "UP" ? upWon : !upWon;
  return { won, winningOutcomeRaw: st.winningOutcome, isVoided: false };
}

/**
 * Net P&L (collateral raw units) of a settled round stake. Winning outcome
 * tokens redeem 1:1 for collateral, so the BUY_YES/BUY_NO taker who paid
 * `costRaw` for `quantityRaw` tokens nets `quantityRaw - costRaw` on a win and
 * `-costRaw` on a loss.
 */
export function tradePnL(
  quantityRaw: bigint,
  costRaw: bigint,
  won: boolean,
): { grossRaw: bigint; netRaw: bigint } {
  return won
    ? { grossRaw: quantityRaw, netRaw: quantityRaw - costRaw }
    : { grossRaw: 0n, netRaw: -costRaw };
}

/**
 * Settle a WON stake: redeem `amountRaw` of the winning outcome tokens for 1:1
 * collateral through the SDK trader (module routes to the settlement, pulling
 * the caller's position from the outcome-token singleton). The loser's tokens
 * redeem for nothing — nothing to settle.
 */
export async function redeemWinningStake(
  market: `0x${string}`,
  outcomeIdx: number,
  amountRaw: bigint,
  key?: `0x${string}`,
): Promise<{ txHash: string | null; error?: string }> {
  const pk = key ?? process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) return { txHash: null, error: "key not set" };
  try {
    const trader = ecExchange().client.createTrader({ privateKey: pk as `0x${string}` });
    const txHash = (await trader.redeem({
      marketId: market,
      amount: amountRaw,
      outcomeIdx: outcomeIdx === 1 ? 1 : 0,
    })).hash;
    return { txHash };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { txHash: null, error: msg.slice(0, 160) };
  }
}

export { ORDER_KIND } from "@somnia-chain/markets-sdk";
export { OUTCOME_UP, OUTCOME_DOWN };

/**
 * @deprecated v2 pools are not ERC20Vaults — collateral escrows via the pool
 * directly (trader.placeOrder auto-approves). Kept for reference.
 */
export function resetStakerClients(): void {
  _publicClient = null;
}
export { ZERO_ADDRESS, EC_ADDRESSES, binarySettlementAbi };