import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EC_CHAIN, EC_RPC_URL, ROUND_ESCROW_ADDRESS } from "../src/lib/ec/config.js";
import { EC_ADDRESSES } from "../src/lib/ec/config.js";

const TUSDC = EC_ADDRESSES.collateral as Address;
const ESCROW = ROUND_ESCROW_ADDRESS as Address;

const TUSDC_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "faucet", stateMutability: "nonpayable", inputs: [{ name: "a", type: "uint256" }], outputs: [] },
] as const;

const ROUND_ESCROW_ABI = [
  { type: "function", name: "topUpProfitPool", stateMutability: "nonpayable", inputs: [{ name: "a", type: "uint256" }], outputs: [] },
] as const;

async function main() {
  const pk = process.env.OPERATOR_PRIVATE_KEY!;
  const account = privateKeyToAccount(pk as `0x${string}`);
  const publicClient = createPublicClient({ chain: EC_CHAIN, transport: http(EC_RPC_URL) });
  const walletClient = createWalletClient({ account, chain: EC_CHAIN, transport: http(EC_RPC_URL) });

  const targetUSDC = Number(process.argv[2] ?? "500");
  const target = BigInt(targetUSDC) * 10n ** 6n;

  const escrowBal = (await publicClient.readContract({ abi: TUSDC_ABI, address: TUSDC, functionName: "balanceOf", args: [ESCROW] })) as bigint;
  console.log(`ROUND_ESCROW=${ESCROW} tUSDC balance=${(escrowBal / 10n ** 6n).toString()}`);
  if (escrowBal >= target) { console.log("already funded"); return; }

  const bal = (await publicClient.readContract({ abi: TUSDC_ABI, address: TUSDC, functionName: "balanceOf", args: [account.address] })) as bigint;
  console.log(`operator tUSDC=${(bal / 10n ** 6n).toString()}`);
  if (bal < target) {
    const amt = target - bal;
    console.log(`faucet ${(amt / 10n ** 6n).toString()}...`);
    const h = await walletClient.writeContract({ abi: TUSDC_ABI, address: TUSDC, functionName: "faucet", args: [amt], chainId: EC_CHAIN.id, gas: 3_000_000n });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
  const allowance = (await publicClient.readContract({ abi: TUSDC_ABI, address: TUSDC, functionName: "allowance", args: [account.address, ESCROW] })) as bigint;
  if (allowance < target) {
    console.log("approve...");
    const h = await walletClient.writeContract({ abi: TUSDC_ABI, address: TUSDC, functionName: "approve", args: [ESCROW, target], chainId: EC_CHAIN.id, gas: 30_000_000n });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
  console.log(`topUpProfitPool ${(target / 10n ** 6n).toString()}...`);
  const th = await walletClient.writeContract({ abi: ROUND_ESCROW_ABI, address: ESCROW, functionName: "topUpProfitPool", args: [target], chainId: EC_CHAIN.id, gas: 30_000_000n });
  await publicClient.waitForTransactionReceipt({ hash: th });
  const after = (await publicClient.readContract({ abi: TUSDC_ABI, address: TUSDC, functionName: "balanceOf", args: [ESCROW] })) as bigint;
  console.log(`ROUND_ESCROW tUSDC now=${(after / 10n ** 6n).toString()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
