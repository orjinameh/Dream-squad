import { createPublicClient, createWalletClient, http, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EC_CHAIN, EC_RPC_URL, ESCROW_ADDRESS } from "./config";
import { DREAMDUEL_ESCROW_ABI } from "./escrowAbi";

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

function publicClient() {
  if (_public) return _public;
  _public = createPublicClient({ chain: EC_CHAIN, transport: http(EC_RPC_URL) });
  return _public;
}

function adminWallet() {
  if (_adminWallet) return _adminWallet;
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) throw new Error("OPERATOR_PRIVATE_KEY is not set (escrow admin)");
  _adminWallet = createWalletClient({
    account: privateKeyToAccount(pk as `0x${string}`),
    chain: EC_CHAIN,
    transport: http(EC_RPC_URL),
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

/** Reads a position slot on `escrow` (defaults to the current deployment). */
export async function positionInfo(windowId: Hash, escrow: `0x${string}` = ESCROW_ADDRESS): Promise<PositionInfo> {
  const p = await publicClient().readContract({
    address: escrow,
    abi: DREAMDUEL_ESCROW_ABI,
    functionName: "position",
    args: [windowId],
  });
  return p as unknown as PositionInfo;
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
