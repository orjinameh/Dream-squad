import { createPublicClient, createWalletClient, http, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EC_CHAIN, ESCROW_ADDRESS, ROUND_ESCROW_ADDRESS, ecHttpTransport } from "./config";
import { DREAMDUEL_ESCROW_ABI, LEGACY_POSITION_ABI, DREAMDUEL_ROUND_ESCROW_ABI } from "./escrowAbi";

/**
 * DreamDuel v2 on-chain escrow client.
 *
 * The escrow holds the player's EC POSITION (a single tUSDC stake for a DreamDEX
 * 15-minute window). Model:
 *   - stake(windowId, amount)  — player deposits/opens their UP or DOWN position.
 *   - settleWindow(windowId, won) — THE only money decision, reported from the
 *     REAL on-chain EC settlement (winningOutcome). win → stake returned in full,
 *     loss → stake forfeited to the house/admin.
 *   - withdraw(windowId) — player collects a WON position.
 *   - collectLost(windowId) — admin collects a LOST position.
 *
 * Combat MATCHES never touch this escrow — matches are stats/rank only and simply
 * reference the player's active position.
 *
 * This module exposes read + admin writes (operator key = escrow `admin`).
 * Player-side `stake` is signed by the player's wallet in the browser.
 *
 * NOTE: Somnia testnet rejects eth_estimateGas for some calls, so every write
 * supplies an explicit `gas` limit. Overshooting is safe.
 */

let _public: ReturnType<typeof createPublicClient> | null = null;
let _adminWallet: ReturnType<typeof createWalletClient> | null = null;

export function publicClient() {
  if (_public) return _public;
  _public = createPublicClient({ chain: EC_CHAIN, transport: ecHttpTransport() });
  return _public;
}

export function adminWallet() {
  if (_adminWallet) return _adminWallet;
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) throw new Error("OPERATOR_PRIVATE_KEY is not set (escrow admin)");
  _adminWallet = createWalletClient({
    account: privateKeyToAccount(pk as `0x${string}`),
    chain: EC_CHAIN,
    transport: ecHttpTransport(),
  });
  return _adminWallet;
}

const ADMIN_GAS = 3_000_000n;

export interface PositionInfo {
  owner: `0x${string}`;
  balance: bigint;
  entryPrice: bigint;
  windowOpen: bigint;
  windowClose: bigint;
  won: bigint; // 0 pending, 1 won, 2 lost
  open: boolean;
  settled: boolean;
}

/** Reads a position slot on `escrow` (defaults to the current deployment).
 *  Legacy deployments (pre-v3) return the 6-field struct (no `entryPrice`), so
 *  the current ABI can't decode them — probe again with the legacy shape and
 *  synthesize entryPrice: 0 when that hits. */
export async function positionInfo(windowId: Hash, escrow: `0x${string}` = ESCROW_ADDRESS): Promise<PositionInfo> {
  const p = (await publicClient().readContract({
    address: escrow,
    abi: DREAMDUEL_ESCROW_ABI,
    functionName: "position",
    args: [windowId],
  }).catch(() => null)) as PositionInfo | null;
  if (p) return p;
  const legacy = (await publicClient().readContract({
    address: escrow,
    abi: LEGACY_POSITION_ABI,
    functionName: "position",
    args: [windowId],
  })) as unknown as {
    owner: `0x${string}`;
    balance: bigint;
    windowOpen: bigint;
    windowClose: bigint;
    won: bigint;
    open: boolean;
    settled: boolean;
  };
  return {
    owner: legacy.owner,
    balance: legacy.balance,
    entryPrice: 0n,
    windowOpen: legacy.windowOpen,
    windowClose: legacy.windowClose,
    won: legacy.won,
    open: legacy.open,
    settled: legacy.settled,
  };
}

/** True if an on-chain position slot exists and is open for `windowId`. */
export async function positionOpen(windowId: Hash, escrow: `0x${string}` = ESCROW_ADDRESS): Promise<boolean> {
  const p = await positionInfo(windowId, escrow);
  return p.open && !p.settled;
}

/**
 * Admin: settle a window after its EC event resolved, from the REAL on-chain EC
 * result. `won=true` commits the DEX payout (stake / entryPrice) to the owner;
 * `won=false` forfeits the stake to the house/admin.
 */
export async function settleWindowOnchain(windowId: Hash, won: boolean, escrow: `0x${string}` = ESCROW_ADDRESS) {
  const wc = adminWallet();
  return wc.writeContract({
    address: escrow,
    abi: DREAMDUEL_ESCROW_ABI,
    functionName: "settleWindow",
    args: [windowId, won],
    chain: EC_CHAIN,
    account: wc.account!,
    gas: ADMIN_GAS,
  });
}

/** Admin: collect a LOST position's forfeited stake to the house. */
export async function collectLostOnchain(windowId: Hash, escrow: `0x${string}` = ESCROW_ADDRESS) {
  const wc = adminWallet();
  return wc.writeContract({
    address: escrow,
    abi: DREAMDUEL_ESCROW_ABI,
    functionName: "collectLost",
    args: [windowId],
    chain: EC_CHAIN,
    account: wc.account!,
    gas: ADMIN_GAS,
  });
}

/**
 * Admin: house funds the payout pool so WON positions can pay the DEX profit
 * (stake / entryPrice) above the base stake.
 */
export async function topUpProfitPoolOnchain(amount: bigint, escrow: `0x${string}` = ESCROW_ADDRESS) {
  const wc = adminWallet();
  return wc.writeContract({
    address: escrow,
    abi: DREAMDUEL_ESCROW_ABI,
    functionName: "topUpProfitPool",
    args: [amount],
    chain: EC_CHAIN,
    account: wc.account!,
    gas: ADMIN_GAS,
  });
}

/** The tUSDC balance held by the escrow (profit pool + open stakes). */
export async function escrowCollateralBalance(escrow: `0x${string}` = ESCROW_ADDRESS): Promise<bigint> {
  return (await publicClient().readContract({
    address: (await publicClient().readContract({
      address: escrow,
      abi: DREAMDUEL_ESCROW_ABI,
      functionName: "collateral",
    })) as `0x${string}`,
    abi: [{ type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const,
    functionName: "balanceOf",
    args: [escrow],
  })) as bigint;
}

/** Admin: change the window length. */
export async function setWindowLengthOnchain(length: bigint) {
  const wc = adminWallet();
  return wc.writeContract({
    address: ESCROW_ADDRESS,
    abi: DREAMDUEL_ESCROW_ABI,
    functionName: "setWindowLength",
    args: [length],
    chain: EC_CHAIN,
    account: wc.account!,
    gas: ADMIN_GAS,
  });
}

// ─── Per-round escrow (DreamDuelRoundEscrow) ─────────────────────────────────
// Same model as the window escrow but keyed by (matchId, round): each round is a
// separate stake that auto-settles at that round's close. Player stakes per round
// (signed by the player in the browser); the operator relay settles each round
// with the real round outcome; the player withdraws their total won balance.

/** Read the current per-round escrow address (defaults to the deployed one). */
export function roundEscrowAddress(): `0x${string}` {
  return ROUND_ESCROW_ADDRESS;
}

/** Read a round lock on the per-round escrow. */
export async function roundLockInfo(matchId: Hash, round: number, escrow: `0x${string}` = ROUND_ESCROW_ADDRESS) {
  const [owner, amount, entryPrice, won, settled] = (await publicClient().readContract({
    address: escrow,
    abi: DREAMDUEL_ROUND_ESCROW_ABI,
    functionName: "roundLock",
    args: [matchId, BigInt(round)],
  })) as [`0x${string}`, bigint, bigint, number, boolean];
  return { owner, amount, entryPrice, won: Number(won), settled };
}

/** Read a match's total withdrawable balance on the per-round escrow. */
export async function roundWithdrawableOnchain(matchId: Hash, escrow: `0x${string}` = ROUND_ESCROW_ADDRESS): Promise<bigint> {
  return (await publicClient().readContract({
    address: escrow,
    abi: DREAMDUEL_ROUND_ESCROW_ABI,
    functionName: "withdrawable",
    args: [matchId],
  })) as bigint;
}

/** Admin: settle a resolved round on the per-round escrow. `won` commits the DEX
 *  payout (stake / entryPrice) to the owner's withdrawable; `false` forfeits. */
export async function settleRoundOnchain(matchId: Hash, round: number, won: boolean, escrow: `0x${string}` = ROUND_ESCROW_ADDRESS) {
  const wc = adminWallet();
  return wc.writeContract({
    address: escrow,
    abi: DREAMDUEL_ROUND_ESCROW_ABI,
    functionName: "settleRound",
    args: [matchId, BigInt(round), won],
    chain: EC_CHAIN,
    account: wc.account!,
    gas: ADMIN_GAS,
  });
}

/** Admin: collect a forfeited (lost) round's stake to the house. */
export async function collectRoundLostOnchain(matchId: Hash, round: number, escrow: `0x${string}` = ROUND_ESCROW_ADDRESS) {
  const wc = adminWallet();
  return wc.writeContract({
    address: escrow,
    abi: DREAMDUEL_ROUND_ESCROW_ABI,
    functionName: "collectLost",
    args: [matchId, BigInt(round)],
    chain: EC_CHAIN,
    account: wc.account!,
    gas: ADMIN_GAS,
  });
}

/**
 * Settle a resolved round on the per-round escrow, guarded so it only runs when
 * the round was actually staked on-chain (non-zero amount) and isn't already
 * settled. No-throw contract (callers fire-and-forget): a missing/unsettled
 * stake must never break a match. `won=true` credits the DEX payout.
 */
export async function settleRoundOnEscrowGuarded(matchId: Hash, round: number, won: boolean, playerAddress?: string) {
  try {
    const lock = await roundLockInfo(matchId, round);
    if (!lock || lock.amount === 0n || lock.settled) return false;
    await settleRoundOnchain(matchId, round, won);
    return true;
  } catch (err) {
    console.error("[round-escrow] guarded settle failed", { matchId: String(matchId), round, won, err });
    return false;
  }
}

/**
 * Place a per-round on-chain stake via the round escrow's `stakeRound`.
 * Called by the operator (admin) on behalf of the player's ghost wallet at
 * COMMIT time — the ghost holds the tUSDC and has approved the round escrow,
 * so the admin can relay the call. No-throw (fire-and-forget): a failed
 * stake must never block the match from advancing.
 */
export async function stakeRoundOnChain(
  matchId: Hash,
  round: number,
  amountRaw: bigint,
  entryPriceRaw: bigint,
  escrow: `0x${string}` = ROUND_ESCROW_ADDRESS,
) {
  const wc = adminWallet();
  return wc.writeContract({
    address: escrow,
    abi: DREAMDUEL_ROUND_ESCROW_ABI,
    functionName: "stakeRound",
    args: [matchId, BigInt(round), amountRaw, entryPriceRaw],
    chain: EC_CHAIN,
    account: wc.account!,
    gas: ADMIN_GAS,
  });
}


