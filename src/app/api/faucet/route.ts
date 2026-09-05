import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAddress, parseUnits } from "viem";
import { adminWallet, publicClient } from "@/lib/ec/escrow";
import { EC_CHAIN, EC_ADDRESSES, EC_COLLATERAL_DECIMALS } from "@/lib/ec/config";
import { jsonError } from "@/lib/utils";

/** tUSDC (testnet collateral) — same address as the venue, 6 dp. */
const TUSDC_ADDRESS: `0x${string}` = (EC_ADDRESSES.testUsdc ?? EC_ADDRESSES.collateral)!;

const TUSDC_ABI = [
  {
    type: "function",
    name: "faucet",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const FAUCET_TUSDC = parseUnits("1000", EC_COLLATERAL_DECIMALS);
const FAUCET_GAS_STT = 500_000_000_000_000_000n; // 0.5 STT for approval+stake txs
const FAUCET_COOLDOWN_MS = 120_000;

const lastFaucetAt = new Map<string, number>();

const faucetSchema = z.object({
  address: z.string().refine((v) => isAddress(v), "invalid address"),
});

export async function POST(req: NextRequest) {
  try {
    const body = faucetSchema.safeParse(await req.json());
    if (!body.success) return jsonError(400, body.error.issues[0]?.message ?? "invalid input");

    const user = (body.data.address as `0x${string}`).toLowerCase() as `0x${string}`;
    const now = Date.now();
    const last = lastFaucetAt.get(user);
    if (last && now - last < FAUCET_COOLDOWN_MS) {
      const waitSec = Math.ceil((FAUCET_COOLDOWN_MS - (now - last)) / 1000);
      return jsonError(429, `faucet cooldown — try again in ${waitSec}s`);
    }
    lastFaucetAt.set(user, now);

    const pc = publicClient();
    const wc = adminWallet();
    const operator = wc.account!.address as `0x${string}`;

    // Native gas: top the user up so their very first approve/stake txs land.
    const userNative = await pc.getBalance({ address: user });
    if (userNative < FAUCET_GAS_STT) {
      const gasTx = await wc.sendTransaction({
        to: user,
        value: FAUCET_GAS_STT - userNative,
        chain: EC_CHAIN,
        account: wc.account!,
      });
      await waitMined(gasTx);
    }

    // tUSDC: the venue token's public `faucet()` mints to the CALLER. Mint any
    // shortfall to the operator, then transfer the fixed grant to the user.
    const opBal = (await pc.readContract({
      address: TUSDC_ADDRESS,
      abi: TUSDC_ABI,
      functionName: "balanceOf",
      args: [operator],
    })) as bigint;

    if (opBal < FAUCET_TUSDC) {
      try {
        const mintTx = await wc.writeContract({
          address: TUSDC_ADDRESS,
          abi: TUSDC_ABI,
          functionName: "faucet",
          args: [FAUCET_TUSDC - opBal],
          chain: EC_CHAIN,
          account: wc.account!,
          gas: 3_000_000n,
        });
        await waitMined(mintTx);
      } catch (err: any) {
        return jsonError(502, `tUSDC faucet unavailable on-chain: ${err?.shortMessage ?? err?.message ?? "mint failed"}`);
      }
    }

    const transferTx = await wc.writeContract({
      address: TUSDC_ADDRESS,
      abi: TUSDC_ABI,
      functionName: "transfer",
      args: [user, FAUCET_TUSDC],
      chain: EC_CHAIN,
      account: wc.account!,
      gas: 3_000_000n,
    });
    await waitMined(transferTx);

    const balance = (await pc.readContract({
      address: TUSDC_ADDRESS,
      abi: TUSDC_ABI,
      functionName: "balanceOf",
      args: [user],
    })) as bigint;

    return NextResponse.json({
      ok: true,
      amount: FAUCET_TUSDC.toString(),
      txHash: transferTx,
      balance: balance.toString(),
    });
  } catch (err: any) {
    console.error("[faucet] failed", err);
    return jsonError(500, err?.message ?? "faucet failed");
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