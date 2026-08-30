import { createPublicClient, createWalletClient, http, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EC_CHAIN, EC_RPC_URL, ESCROW_ADDRESS } from "./config";
import { escrowMatchId } from "./matchId";
import { DREAMDUEL_ESCROW_ABI } from "./escrowAbi";

/**
 * DreamDuel on-chain escrow client.
 *
 * The escrow holds both players' tUSDC pledges for a PvP match and pays the
 * winner on settlement. This module exposes:
 *   - read helpers (public, no key);
 *   - admin write helpers (openMatch/settle/draw) driven by the operator key
 *     (the escrow's configured `admin`).
 *
 * Player-side `stake` is NOT here — it must be signed by the player's own
 * wallet in the browser, so the game UI calls it directly.
 *
 * NOTE: Somnia testnet rejects eth_estimateGas for some calls and uses a steep
 * gas schedule, so every write supplies an explicit `gas` limit. Overshooting
 * is safe — only consumed gas is paid.
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
const READ_GAS = 500_000n;

export async function matchInfo(id: string) {
  return publicClient().readContract({
    address: ESCROW_ADDRESS,
    abi: DREAMDUEL_ESCROW_ABI,
    functionName: "matches",
    args: [escrowMatchId(id)],
  });
}

/** Admin: register both participants for a match before anyone stakes. */
export async function openMatchOnchain(id: string, playerA: `0x${string}`, playerB: `0x${string}`) {
  const wc = adminWallet();
  return wc.writeContract({
    address: ESCROW_ADDRESS,
    abi: DREAMDUEL_ESCROW_ABI,
    functionName: "openMatch",
    args: [escrowMatchId(id), playerA, playerB],
    chain: EC_CHAIN,
    account: wc.account!,
    gas: ADMIN_GAS,
  });
}

/** Admin: pay the winner the full pot. Guards require both players staked. */
export async function settleOnchain(id: string, winner: `0x${string}`) {
  const wc = adminWallet();
  return wc.writeContract({
    address: ESCROW_ADDRESS,
    abi: DREAMDUEL_ESCROW_ABI,
    functionName: "settle",
    args: [escrowMatchId(id), winner],
    chain: EC_CHAIN,
    account: wc.account!,
    gas: ADMIN_GAS,
  });
}

/** Admin: refund both players (a draw / void). */
export async function drawOnchain(id: string) {
  const wc = adminWallet();
  return wc.writeContract({
    address: ESCROW_ADDRESS,
    abi: DREAMDUEL_ESCROW_ABI,
    functionName: "draw",
    args: [escrowMatchId(id)],
    chain: EC_CHAIN,
    account: wc.account!,
    gas: ADMIN_GAS,
  });
}
