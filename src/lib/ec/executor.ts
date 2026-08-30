import { createPublicClient, http, defineChain } from "viem";
import { SomniaMarkets, upProbability, type MarketOnchain, type UnifiedMarket, type BinaryMarket } from "@somnia-chain/markets-sdk";
import {
  EC_ADDRESSES, EC_CHAIN, EC_CHAIN_ID, EC_INDEXER_URL, EC_RPC_URL, EC_RPC_WS_URL,
  EC_COLLATERAL_DECIMALS,
} from "./config";

/**
 * DreamDEX Event Contract (binary YES/NO) access for DreamDuel.
 *
 * Event-Contract pools gate operators via `OnlyApprovedContracts` — an ordinary
 * EOA (our backend) cannot place orders on them for anyone. So the EC layer here
 * is the REAL Oracle + settlement anchor, not a per-player trading path:
 *
 *   - RESOLVE the active BTC/ETH binary market (the "arena floor") with its real
 *     strike + expiry.
 *   - ORACLE the live YES/NO price from the market's real order book — the feed
 *     every match round is resolved against.
 *   - READ on-chain collateral / outcome balances and post-settlement state.
 *
 * Financial settlement of a match's prize pot is handled by the DreamDuel escrow
 * contract (a real on-chain tUSDC vault), not by this module.
 */

const RPC_URL = process.env.SOMNIA_RPC_URL ?? EC_RPC_URL;

let _exchange: SomniaMarkets | null = null;
let _publicClient: ReturnType<typeof createPublicClient> | null = null;

export function ecExchange(): SomniaMarkets {
  if (_exchange) return _exchange;
  _exchange = new SomniaMarkets({
    indexerUrl: EC_INDEXER_URL,
    chain: EC_CHAIN,
    wsRpcUrl: EC_RPC_WS_URL,
    addresses: EC_ADDRESSES,
  });
  return _exchange;
}

export function ecPublicClient() {
  if (_publicClient) return _publicClient;
  _publicClient = createPublicClient({ chain: EC_CHAIN, transport: http(RPC_URL) });
  return _publicClient;
}

// ─── Arena floor: the active market window ──────────────────────────────────

export interface EcArenaMarket {
  symbol: string; // e.g. "BTC-7812345-30AUG26-1200/tUSDC"
  marketId: string;
  pool: `0x${string}`;
  collateral: `0x${string}`;
  token: `0x${string}`; // ERC-6909 outcome-token singleton
  yesId: bigint;
  noId: bigint;
  strike: string;
  decimals: number;
  expiry: number; // unix seconds
}

/**
 * Resolve the currently-trading binary market for an asset ("BTC"|"ETH") that
 * has a real strike (not the place-holder zero strike) and a future expiry.
 * Prefers the window with the longest time remaining that still has >minLeftSec.
 * Returns null when no such live arena floor exists (e.g. between windows).
 */
export async function findArenaFloor(
  asset: "BTC" | "ETH",
  minLeftSec = 0,
): Promise<EcArenaMarket | null> {
  const prefix = asset === "BTC" ? "BTC-" : "ETH-";
  const exchange = ecExchange();
  const now = Math.floor(Date.now() / 1000);

  let markets: UnifiedMarket[] = Object.values(exchange.markets ?? {});
  if (markets.length === 0) {
    markets = Object.values(await exchange.loadMarkets(true));
  }

  const floors: EcArenaMarket[] = [];
  for (const m of markets) {
    if (m.type !== "binary") continue;
    const info = m.info as BinaryMarket;
    if (!m.symbol.startsWith(prefix)) continue;
    if (m.symbol.includes("-0-")) continue; // never a tradeable strike
    const onchain = await exchange.client
      .getMarketOnchain(m.id as `0x${string}`)
      .catch(() => null);
    if (!onchain) continue;
    if (onchain.status !== 1 || onchain.isResolved) continue; // only live + unsettled
    if (!onchain.expiry || Number(onchain.expiry) <= now) continue;
    const leftSec = Number(onchain.expiry) - now;
    if (leftSec < minLeftSec) continue;
    floors.push({
      symbol: m.symbol,
      marketId: m.id,
      pool: onchain.pool,
      collateral: onchain.collateral ?? EC_ADDRESSES.collateral,
      token: onchain.outcomeToken ?? EC_ADDRESSES.collateral,
      yesId: onchain.yesId,
      noId: onchain.noId,
      strike: info.strike ?? "",
      decimals: onchain.decimals,
      expiry: Number(onchain.expiry),
    });
  }

  if (floors.length === 0) return null;
  // Prefer the arena with the most time left (the freshest window).
  floors.sort((a, b) => b.expiry - a.expiry);
  return floors[0];
}

// ─── Live YES price oracle (real order book) ────────────────────────────────

export interface EcPriceQuote {
  yesPrice: number | null; // human probability in (0,1): 0.5 = 50/50
  bestBid: number | null;
  bestAsk: number | null;
  updatedMs: number;
}

/**
 * Read the live price of the arena's YES token straight from the market's real
 * order book (mid of best bid/ask). This is the oracle every round resolves on.
 * Returns nulls when the book has no two-sided depth yet.
 */
export async function readArenaPrice(arena: EcArenaMarket): Promise<EcPriceQuote> {
  const exchange = ecExchange();
  try {
    const book = await exchange.fetchOrderBook(arena.symbol, 1);
    const bestBid = book.bids[0]?.[0] ?? null;
    const bestAsk = book.asks[0]?.[0] ?? null;
    const yesPrice =
      bestBid !== null && bestAsk !== null
        ? (bestBid + bestAsk) / 2
        : bestBid ?? bestAsk;
    return {
      yesPrice: yesPrice === null ? null : yesPrice,
      bestBid: bestBid === null ? null : bestBid,
      bestAsk: bestAsk === null ? null : bestAsk,
      updatedMs: Date.now(),
    };
  } catch {
    return { yesPrice: null, bestBid: null, bestAsk: null, updatedMs: Date.now() };
  }
}

/** Raw YES balance → human probability (0..1). */
export function yesToProbability(rawYes: bigint | string | null | undefined, decimals?: number): number | null {
  return upProbability(rawYes, decimals ?? EC_COLLATERAL_DECIMALS);
}

// ─── On-chain settlement reads ──────────────────────────────────────────────

export interface EcAccountBalances {
  collateral: bigint; // tUSDC (6 dp) held in the wallet
  yes: bigint; // YES outcome tokens held
  no: bigint; // NO outcome tokens held
  decimals: number;
}

export async function readArenaBalances(addr: string, arena: EcArenaMarket): Promise<EcAccountBalances> {
  const exchange = ecExchange();
  const client = exchange.client;
  const [yes, no, collateral] = await Promise.all([
    client
      .getOutcomeBalance({ outcomeToken: arena.token, account: addr as `0x${string}`, id: arena.yesId })
      .catch(() => 0n),
    client
      .getOutcomeBalance({ outcomeToken: arena.token, account: addr as `0x${string}`, id: arena.noId })
      .catch(() => 0n),
    client.getErc20Balance(arena.collateral, addr as `0x${string}`).catch(() => 0n),
  ]);
  return { collateral, yes, no, decimals: arena.decimals };
}

/**
 * Read the on-chain state of the arena floor after (or before) settlement.
 * `isResolved` is the binary settlement flag; `winningOutcome` is 0=YES / 1=NO.
 */
export async function readArenaSettlement(arena: EcArenaMarket): Promise<{
  isResolved: boolean;
  winningOutcome: number;
  status: number;
}> {
  const exchange = ecExchange();
  try {
    const oc = await exchange.client.getMarketOnchain(arena.pool);
    return {
      isResolved: oc.isResolved,
      winningOutcome: Number(oc.winningOutcome ?? 0),
      status: oc.status,
    };
  } catch {
    return { isResolved: false, winningOutcome: 0, status: 0 };
  }
}

export { EC_COLLATERAL_DECIMALS };
