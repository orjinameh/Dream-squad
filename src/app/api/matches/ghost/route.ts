import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";
import { connectToDatabase } from "@/db/connect";
import { Match } from "@/db/models/Match";
import { jsonError } from "@/lib/utils";
import { adminWallet, publicClient } from "@/lib/ec/escrow";
import { ESCROW_ADMIN, EC_CHAIN, EC_ADDRESSES } from "@/lib/ec/config";

/** tUSDC (testnet collateral) — same address as the venue, 6 dp. */
const TUSDC_ADDRESS: `0x${string}` = (EC_ADDRESSES.testUsdc ?? EC_ADDRESSES.collateral)!;

const TUSDC_ABI = [
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
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const fundSchema = z.object({
  matchId: z.string().min(1),
  playerAddress: z.string().refine((v) => isAddress(v), "invalid address"),
  ghostAddress: z.string().refine((v) => isAddress(v), "invalid address"),
  totalStakeRaw: z.string().regex(/^\d+$/, "totalStakeRaw must be a uint string"),
});

export async function POST(req: NextRequest) {
  try {
    await connectToDatabase();
    const body = fundSchema.safeParse(await req.json());
    if (!body.success) return jsonError(400, body.error.issues[0]?.message ?? "invalid input");

    const { matchId, playerAddress, ghostAddress, totalStakeRaw } = body.data;
    const amount = BigInt(totalStakeRaw);
    if (amount <= 0n) return jsonError(400, "amount must be > 0");

    const match = await Match.findById(matchId).lean();
    if (!match) return jsonError(404, "match not found");

    // Guard: only fund the ghost for a match owned by the requesting player.
    // Accept player 1 OR player 2 (PvP) as a legitimate owner of this match.
    const pl = playerAddress.toLowerCase();
    const p1 = (match.playerAddress ?? "").toString().toLowerCase();
    const p2 = (match.player2Address ?? "").toString().toLowerCase();
    const isOwner =
      (p1 && p1 === pl) ||
      (p2 && p2 === pl) ||
      p1 === "0x0000000000000000000000000000000000000000";
    if (!isOwner) {
      return jsonError(403, "not your match");
    }

    const pc = publicClient();

    // The player must have approved the OPERATOR (ESCROW_ADMIN) as spender for
    // this amount in a single lobby popup. Verify before relaying.
    const allowance = (await pc.readContract({
      address: TUSDC_ADDRESS,
      abi: TUSDC_ABI,
      functionName: "allowance",
      args: [playerAddress as `0x${string}`, ESCROW_ADMIN],
    })) as bigint;
    if (allowance < amount) {
      return jsonError(402, `insufficient allowance: approved ${allowance} of ${amount}`);
    }

    // Idempotency guard: the ghost key is stable per match, so a re-mount that
    // re-invokes this route must NOT charge the player a second time. If the
    // ghost already holds the full stake, it's already funded — no new transfer.
    const ghostBal = (await pc.readContract({
      address: TUSDC_ADDRESS,
      abi: TUSDC_ABI,
      functionName: "balanceOf",
      args: [ghostAddress as `0x${string}`],
    })) as bigint;
    if (ghostBal >= amount) {
      return NextResponse.json({ ok: true, alreadyFunded: true, ghostBalance: ghostBal.toString() });
    }

    const wc = adminWallet();
    const tx = await wc.writeContract({
      address: TUSDC_ADDRESS,
      abi: TUSDC_ABI,
      functionName: "transferFrom",
      args: [playerAddress as `0x${string}`, ghostAddress as `0x${string}`, amount],
      chain: EC_CHAIN,
      account: wc.account!,
      // tUSDC ops on Somnia run hot (~1.1M+); the old 1.5M cap could revert
      // out-of-gas, leaving the player charged nothing but the arena unfunded.
      gas: 3_000_000n,
    });

    // Wait for the relay to mine so the ghost has funds before the fight starts.
    const receipt = await waitMined(tx);
    const ghostBalance = (await pc.readContract({
      address: TUSDC_ADDRESS,
      abi: TUSDC_ABI,
      functionName: "balanceOf",
      args: [ghostAddress as `0x${string}`],
    })) as bigint;

    return NextResponse.json({ ok: true, txHash: tx, gasUsed: Number(receipt.gasUsed), ghostBalance: ghostBalance.toString() });
  } catch (err: any) {
    console.error("[ghost/fund] failed", err);
    return jsonError(500, err?.message ?? "failed to fund ghost wallet");
  }
}

async function waitMined(hash: `0x${string}`) {
  const pc = publicClient();
  for (let i = 0; i < 40; i++) {
    try {
      const r = await pc.getTransactionReceipt({ hash });
      if (r) return r;
    } catch {
      /* not mined yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("relay tx did not confirm in time");
}
