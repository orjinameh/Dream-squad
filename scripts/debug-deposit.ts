import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SOMNIA_CHAIN, SPOT_POOL_ABI, MAX_FEE } from "../src/lib/config";
import { MARKETS } from "../src/lib/markets";

const FUND_KEY = "0x84e04f1fd7ce8f03c4d0862945c032646633dcdf3ca852a969d4833d4333c1a4";
const FUND = "0x9196d7670eea0CB723af11465d4285541a2eA86a" as `0x${string}`;
const RPC = "https://dream-rpc.somnia.network";

const account = privateKeyToAccount(FUND_KEY);
const client = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ account, chain: SOMNIA_CHAIN, transport: http(RPC) });
const market = MARKETS["SOMI:USDso"];

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }] },
] as const;

const DEPOSIT_ABI = [{ type: "function", name: "deposit", stateMutability: "nonpayable",
  inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] as const;

async function main() {
  // Get base token address from pool
  const POOL_ABI_FULL = [...SPOT_POOL_ABI, { type: "function", name: "getPoolParams", stateMutability: "view",
    inputs: [], outputs: [
      { name: "baseToken_", type: "address" }, { name: "quoteToken_", type: "address" },
      {}, {}, {}, {}, {}
    ] }] as const;
  const params = await client.readContract({ address: market.pool, abi: POOL_ABI_FULL, functionName: "getPoolParams" });
  const baseToken = params[0];

  // Check wallet SOMI balance
  const somiBal = await client.readContract({ address: baseToken, abi: ERC20_ABI, functionName: "balanceOf", args: [FUND] });
  console.log(`Wallet SOMI balance: ${formatUnits(somiBal, 18)}`);

  if (somiBal < parseUnits("1", 18)) {
    console.log("Insufficient SOMI in wallet to fill vault to minQty (1 SOMI).");
    console.log("Trying depositNative with 0.55 STT to push vault above 1 SOMI...");

    // First check current vault
    const WITHDRAW_ABI = [{ type: "function", name: "getWithdrawableBalance", stateMutability: "view",
      inputs: [{ name: "owner", type: "address" }, { name: "token", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const;
    const vaultBal = await client.readContract({ address: market.pool, abi: WITHDRAW_ABI, functionName: "getWithdrawableBalance", args: [FUND, baseToken] });
    console.log(`Current vault SOMI: ${formatUnits(vaultBal, 18)}`);

    // Try depositNative
    try {
      const h = await wallet.writeContract({
        address: market.pool, abi: SPOT_POOL_ABI,
        functionName: "depositNative", value: parseUnits("0.55", 18),
        maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 100_000_000n,
      });
      const rc = await client.waitForTransactionReceipt({ hash: h });
      console.log(`depositNative: ${rc.status} gas=${rc.gasUsed}`);
    } catch (e: any) {
      console.log(`depositNative failed: ${e?.shortMessage?.slice(0, 200) || e?.message}`);
    }
    return;
  }

  // If wallet has SOMI, approve + deposit
  console.log("Approving pool to spend SOMI...");
  const h1 = await wallet.writeContract({
    address: baseToken, abi: ERC20_ABI,
    functionName: "approve", args: [market.pool, somiBal],
    maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 100_000_000n,
  });
  await client.waitForTransactionReceipt({ hash: h1 });
  console.log(`Approved. Depositing 1 SOMI into vault...`);

  const h2 = await wallet.writeContract({
    address: market.pool, abi: DEPOSIT_ABI,
    functionName: "deposit", args: [baseToken, parseUnits("1", 18)],
    maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 100_000_000n,
  });
  const rc = await client.waitForTransactionReceipt({ hash: h2 });
  console.log(`deposit: ${rc.status} gas=${rc.gasUsed}`);
}
main().catch(console.error);
