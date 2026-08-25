import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SOMNIA_CHAIN, SPOT_POOL_ABI } from "../src/lib/config";

const FUND_KEY = "0x84e04f1fd7ce8f03c4d0862945c032646633dcdf3ca852a969d4833d4333c1a4";
const FUND = "0x9196d7670eea0CB723af11465d4285541a2eA86a" as `0x${string}`;
const POOL = "0x259fD6559214dd5aD3752322426eA9F9fABEFff4" as `0x${string}`;
const BASE = "0x28f34DeFd2b4CB48d9eE6d89f2Be4Bc601694c00" as `0x${string}`;
const RPC = "https://dream-rpc.somnia.network";
const MAX_FEE = 10_000_000_000n;
const MAX_PRIO = 100_000_000n;

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;

const DEPOSIT_ABI = [{ type: "function", name: "deposit", stateMutability: "nonpayable",
  inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] as const;

const account = privateKeyToAccount(FUND_KEY);
const client = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ account, chain: SOMNIA_CHAIN, transport: http(RPC) });

async function main() {
  // Wallet SOMI balance
  const somiBal = await client.readContract({ address: BASE, abi: ERC20_ABI, functionName: "balanceOf", args: [FUND] });
  console.log(`Wallet SOMI: ${formatUnits(somiBal, 18)}`);

  // Vault SOMI balance
  const WITHDRAW_ABI = [{ type: "function", name: "getWithdrawableBalance", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "token", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const;
  const vaultBal = await client.readContract({ address: POOL, abi: WITHDRAW_ABI, functionName: "getWithdrawableBalance", args: [FUND, BASE] });
  console.log(`Vault SOMI: ${formatUnits(vaultBal, 18)}`);

  const totalNeeded = parseUnits("1", 18); // minQty
  const deficit = totalNeeded - vaultBal;
  console.log(`Deficit: ${formatUnits(deficit, 18)} SOMI`);

  if (somiBal >= deficit) {
    console.log("\nWallet has enough SOMI. Depositing into vault...");
    const allowance = await client.readContract({ address: BASE, abi: ERC20_ABI, functionName: "allowance", args: [FUND, POOL] });
    if (allowance < deficit) {
      const h1 = await wallet.writeContract({ address: BASE, abi: ERC20_ABI, functionName: "approve", args: [POOL, somiBal], maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: MAX_PRIO });
      await client.waitForTransactionReceipt({ hash: h1 });
      console.log(`Approved pool. tx: https://shannon-explorer.somnia.network/tx/${h1}`);
    }
    const h2 = await wallet.writeContract({ address: POOL, abi: DEPOSIT_ABI, functionName: "deposit", args: [BASE, deficit], maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: MAX_PRIO });
    const rc = await client.waitForTransactionReceipt({ hash: h2 });
    console.log(`Deposit: ${rc.status} gas=${rc.gasUsed} tx: https://shannon-explorer.somnia.network/tx/${h2}`);
  } else {
    console.log(`Insufficient SOMI in wallet. Need ${formatUnits(deficit, 18)}, have ${formatUnits(somiBal, 18)}`);
    console.log("Try depositNative to see if STT->SOMI wrapping works...");
    try {
      const h = await wallet.writeContract({ address: POOL, abi: SPOT_POOL_ABI, functionName: "depositNative", value: parseUnits("0.55", 18), maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: MAX_PRIO });
      const rc = await client.waitForTransactionReceipt({ hash: h });
      console.log(`depositNative: ${rc.status} gas=${rc.gasUsed}`);
    } catch (e: any) {
      console.log(`depositNative failed: ${e?.shortMessage?.slice(0, 200)}`);
    }
  }
}
main().catch(console.error);
