import { createPublicClient } from "viem";
import { EC_CHAIN, EC_ADDRESSES, ESCROW_ADMIN, ecHttpTransport } from "./config";
import { adminWallet, publicClient } from "./escrow";

/**
 * "Confirm fund before opening match" gate.
 *
 * The POSITION screen collects a single operator approval (player → tUSDC
 * allowance for ESCROW_ADMIN covering amount × rounds). Before a match may
 * open, the server re-verifies that approval ON-CHAIN — a DB position record
 * alone is not proof of funding. Bounded (10s) so a stalled RPC degrades to
 * "unverifiable" instead of hanging match creation.
 */

const TUSDC_ADDRESS: `0x${string}` = (EC_ADDRESSES.testUsdc ?? EC_ADDRESSES.collateral)!;

const ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const FUND_CHECK_TIMEOUT_MS = 10_000;
// Bound for the per-round funding draw's on-chain confirmation (shorter than
// the COMMIT stake gate so the two legs fit in one gate hold).
const FUND_DRAW_TIMEOUT_MS = 45_000;

export function matchPotRaw(amountPerRound: number, totalRounds: number): bigint {
  return BigInt(Math.round(amountPerRound * 1_000_000)) * BigInt(totalRounds);
}

export type FundingCheck =
  | { ok: true }
  | { ok: false; reason: "insufficient" | "unverifiable"; allowance: string; required: string };

export async function assertMatchFunding(
  playerAddress: `0x${string}`,
  amountPerRound: number,
  totalRounds: number,
): Promise<FundingCheck> {
  // Fast-test mode skips the on-chain read (no RPC in unit tests) — the stake
  // gate is likewise bypassed there. Production always verifies.
  if (process.env.DREAMDUEL_FAST_ROUNDS === "1") return { ok: true };
  const required = matchPotRaw(amountPerRound, totalRounds);
  const allowance = await readOperatorAllowance(playerAddress);
  if (allowance == null) {
    return { ok: false, reason: "unverifiable", allowance: "unknown", required: required.toString() };
  }
  if (allowance >= required) return { ok: true };
  return { ok: false, reason: "insufficient", allowance: allowance.toString(), required: required.toString() };
}

async function readOperatorAllowance(playerAddress: `0x${string}`): Promise<bigint | null> {
  try {
    const pc = createPublicClient({ chain: EC_CHAIN, transport: ecHttpTransport() });
    const allowance = (await Promise.race([
      pc.readContract({
        address: TUSDC_ADDRESS,
        abi: ALLOWANCE_ABI,
        functionName: "allowance",
        args: [playerAddress, ESCROW_ADMIN],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("funding check timed out")), FUND_CHECK_TIMEOUT_MS),
      ),
    ])) as bigint;
    return allowance;
  } catch {
    return null;
  }
}

const TRANSFER_FROM_ABI = [
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * Draw one confirmed round's funding from the player's operator approval:
 * `transferFrom(player → operator, amountRaw)`, receipt awaited. This is what
 * consumes the match pot across the 7 COMMIT gates — after a full match the
 * approval is spent and replay needs a fresh one. Never throws: returns
 * `{ txHash }` or `{ error }` so the gate can hold COMMIT on failure.
 */
export async function collectRoundFunding(
  playerAddress: `0x${string}`,
  amountRaw: bigint,
): Promise<{ txHash: string | null; error?: string }> {
  if (amountRaw <= 0n) return { txHash: null, error: "nothing to collect" };
  try {
    const wc = adminWallet();
    const operator = wc.account!.address as `0x${string}`;
    const allowance = await readOperatorAllowance(playerAddress);
    if (allowance == null) return { txHash: null, error: "could not verify funding approval" };
    if (allowance < amountRaw) {
      return { txHash: null, error: `funding approval exhausted (has ${allowance}, needs ${amountRaw})` };
    }
    const txHash = await wc.writeContract({
      address: TUSDC_ADDRESS,
      abi: TRANSFER_FROM_ABI,
      functionName: "transferFrom",
      args: [playerAddress, operator, amountRaw],
      chain: EC_CHAIN,
      account: wc.account!,
      gas: 3_000_000n,
    });
    const pc = publicClient();
    const receipt = (await Promise.race([
      pc.waitForTransactionReceipt({ hash: txHash }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("funding confirmation timed out")), FUND_DRAW_TIMEOUT_MS),
      ),
    ])) as { status?: string };
    if (receipt.status && receipt.status !== "success") {
      return { txHash: null, error: `funding transfer reverted (status=${receipt.status})` };
    }
    return { txHash };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { txHash: null, error: msg.slice(0, 160) };
  }
}
