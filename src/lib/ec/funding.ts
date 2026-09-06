import { createPublicClient } from "viem";
import { EC_CHAIN, EC_ADDRESSES, ESCROW_ADMIN, ecHttpTransport } from "./config";

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
    if (allowance >= required) return { ok: true };
    return { ok: false, reason: "insufficient", allowance: allowance.toString(), required: required.toString() };
  } catch {
    return { ok: false, reason: "unverifiable", allowance: "unknown", required: required.toString() };
  }
}
