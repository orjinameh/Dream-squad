import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EC_CHAIN, EC_RPC_URL, ESCROW_ADDRESS } from "../src/lib/ec/config.js";
import { EC_ADDRESSES } from "../src/lib/ec/config.js";
import { topUpProfitPoolOnchain, escrowCollateralBalance } from "../src/lib/ec/escrow.js";

/**
 * Fund the v3 escrow's profit pool (the DEX payout liability).
 *
 * The v3 escrow pays the fixed $1.00-per-token DEX payout (stake / entryPrice) on
 * a win, but it can never mint — payouts must be sitting in its tUSDC balance.
 * This script (run with the escrow-admin/operator key) tops that pool up:
 *   1. faucet tUSDC to the operator if its balance is short of target,
 *   2. approve the escrow to spend that amount,
 *   3. topUpProfitPool(target).
 *
 * Run:  npx tsx scripts/fund-profit-pool.ts [poolTargetUSDC]
 * Env:  OPERATOR_PRIVATE_KEY (escrow admin)
 */
const TUSDC = EC_ADDRESSES.collateral as Address;

const TUSDC_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
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
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "faucet",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

async function main() {
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) throw new Error("OPERATOR_PRIVATE_KEY is not set");
  const account = privateKeyToAccount(pk as `0x${string}`);
  const publicClient = createPublicClient({ chain: EC_CHAIN, transport: http(EC_RPC_URL) });
  const walletClient = createWalletClient({ account, chain: EC_CHAIN, transport: http(EC_RPC_URL) });

  const targetUSDC = Number(process.argv[2] ?? "500");
  const target = BigInt(targetUSDC) * 10n ** 6n;
  const decimals = 6n;

  const escrowBal = await escrowCollateralBalance(ESCROW_ADDRESS);
  console.log(`escrow=${ESCROW_ADDRESS}`);
  console.log(
    `escrow tUSDC balance=${(escrowBal / 10n ** decimals).toString()} (target pool ${targetUSDC})`,
  );
  if (escrowBal >= target && !process.argv.includes("--force")) {
    console.log("profit pool already funded — nothing to do");
    return;
  }

  const bal = (await publicClient.readContract({
    abi: TUSDC_ABI,
    address: TUSDC,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;
  console.log(`operator tUSDC balance=${(bal / 10n ** decimals).toString()}`);

  let faucetAmt = 0n;
  if (bal < target) {
    faucetAmt = target - bal;
    console.log(`fauceting ${(faucetAmt / 10n ** decimals).toString()} tUSDC to operator...`);
    const hash = await walletClient.writeContract({
      abi: TUSDC_ABI,
      address: TUSDC,
      functionName: "faucet",
      args: [faucetAmt],
      chainId: EC_CHAIN.id,
      gas: 3_000_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`faucet tx=${hash}`);
  }

  const allowance = (await publicClient.readContract({
    abi: TUSDC_ABI,
    address: TUSDC,
    functionName: "allowance",
    args: [account.address, ESCROW_ADDRESS],
  })) as bigint;
  if (allowance < target) {
    console.log("approving escrow...");
    const hash = await walletClient.writeContract({
      abi: TUSDC_ABI,
      address: TUSDC,
      functionName: "approve",
      args: [ESCROW_ADDRESS, target],
      chainId: EC_CHAIN.id,
      gas: 30_000_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`approve tx=${hash}`);
  }

  console.log(`topUpProfitPool ${(target / 10n ** decimals).toString()} tUSDC...`);
  const topHash = await topUpProfitPoolOnchain(target, ESCROW_ADDRESS);
  console.log(`topUp tx=${topHash}`);
  await publicClient.waitForTransactionReceipt({ hash: topHash as `0x${string}` });

  const after = await escrowCollateralBalance(ESCROW_ADDRESS);
  console.log(`escrow tUSDC balance now=${(after / 10n ** decimals).toString()}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });