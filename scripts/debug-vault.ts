import { createPublicClient, http, formatUnits, encodeFunctionData } from "viem";
import { SOMNIA_CHAIN, SPOT_POOL_ABI, OPERATOR_ADDRESS } from "../src/lib/config";
import { MARKETS } from "../src/lib/markets";

const RPC = "https://dream-rpc.somnia.network";
const FUND = "0x9196d7670eea0CB723af11465d4285541a2eA86a" as `0x${string}`;
const client = createPublicClient({ transport: http(RPC) });
const market = MARKETS["SOMI:USDso"];

async function main() {
  // 1. Check vault balance (getWithdrawableBalance)
  const WITHDRAW_ABI = [{ type: "function", name: "getWithdrawableBalance", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] }] as const;

  // Need the base token address - read from pool params
  const POOL_ABI = [...SPOT_POOL_ABI, { type: "function", name: "getPoolParams", stateMutability: "view",
    inputs: [], outputs: [
      { name: "baseToken_", type: "address" }, { name: "quoteToken_", type: "address" },
      { name: "makerFeeBpsTimes1k_", type: "uint256" }, { name: "takerFeeBpsTimes1k_", type: "uint256" },
      { name: "tickSize_", type: "uint256" }, { name: "minQuantity_", type: "uint256" },
      { name: "lotSize_", type: "uint256" }
    ] }] as const;

  const params = await client.readContract({ address: market.pool, abi: POOL_ABI, functionName: "getPoolParams" });
  const baseToken = params[0];
  const quoteToken = params[1];
  console.log(`Pool baseToken: ${baseToken}`);
  console.log(`Pool quoteToken: ${quoteToken}`);

  const baseBal = await client.readContract({ address: market.pool, abi: WITHDRAW_ABI, functionName: "getWithdrawableBalance", args: [FUND, baseToken] });
  const quoteBal = await client.readContract({ address: market.pool, abi: WITHDRAW_ABI, functionName: "getWithdrawableBalance", args: [FUND, quoteToken] });
  console.log(`Vault base (SOMI): ${formatUnits(baseBal, 18)}`);
  console.log(`Vault quote (USDso): ${formatUnits(quoteBal, 18)}`);

  // 2. Check operator authorization
  const authed = await client.readContract({ address: market.pool, abi: SPOT_POOL_ABI,
    functionName: "isOperatorAuthorized", args: [FUND, OPERATOR_ADDRESS as `0x${string}`, "0x80054449" as `0x${string}`] });
  console.log(`Operator authorized: ${authed}`);

  // 3. Try to simulate the IOC SELL order via eth_call
  const nowSec = Math.floor(Date.now() / 1000);
  const expireNs = BigInt(nowSec + 60) * 1_000_000_000n;
  const quantity = 1000000000000000000n; // 1 SOMI
  const price = 1n; // lowest for SELL IOC

  try {
    const result = await client.call({
      to: market.pool,
      data: encodeFunctionData({
        abi: SPOT_POOL_ABI, functionName: "placeOrderFor",
        args: [FUND, false, 0n, price, quantity, expireNs, 2, 0, "0x0000000000000000000000000000000000000000" as `0x${string}`, 0n],
      }),
      account: OPERATOR_ADDRESS as `0x${string}`,
    });
    console.log(`Simulation result: ${result}`);
  } catch (e: any) {
    console.log(`Simulation FAILED: ${e?.shortMessage || e?.message || e}`);
  }
}
main().catch(console.error);
