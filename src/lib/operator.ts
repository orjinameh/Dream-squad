import { createWalletClient, createPublicClient, http, parseUnits, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SOMNIA_CHAIN, SPOT_POOL_ABI, ORDER_TYPE, crossingPrice, ZERO_ADDRESS } from "./config";
import { MARKETS, GAS_LIMIT_PER_ORDER } from "./markets";

const RPC_URL = process.env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network";

let _walletClient: ReturnType<typeof createWalletClient> | null = null;
let _publicClient: ReturnType<typeof createPublicClient> | null = null;

function walletClient() {
  if (_walletClient) return _walletClient;
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) throw new Error("OPERATOR_PRIVATE_KEY is not set");
  const account = privateKeyToAccount(pk as `0x${string}`);
  _walletClient = createWalletClient({
    account,
    chain: SOMNIA_CHAIN,
    transport: http(RPC_URL),
  });
  return _walletClient;
}

function publicClient() {
  if (_publicClient) return _publicClient;
  _publicClient = createPublicClient({ chain: SOMNIA_CHAIN, transport: http(RPC_URL) });
  return _publicClient;
}

export async function checkOperatorWarmup(): Promise<{ ready: boolean; balanceSTT: number }> {
  const wc = walletClient();
  const addr = wc.account!.address;
  const balance = await publicClient().getBalance({ address: addr });
  return { ready: balance > parseUnits("0.05", 18), balanceSTT: Number(formatUnits(balance, 18)) };
}

/**
 * Execute one IOC (immediate-or-cancel) market order on behalf of `ownerAddress`.
 * Returns the txHash on success, throws on any revert.
 */
export async function executeTradeOnChain(
  marketSymbol: string,
  ownerAddress: string,
  amount: number,
  direction: "BUY" | "SELL",
): Promise<string> {
  const market = MARKETS[marketSymbol];
  if (!market) throw new Error(`Unknown market: ${marketSymbol}`);

  const quantity = parseUnits(amount.toString(), market.baseDecimals);
  const price = crossingPrice(direction, market.quoteDecimals);
  const isBid = direction === "BUY";
  const nowSec = Math.floor(Date.now() / 1000);
  const expireNs = BigInt(nowSec + 60) * 1_000_000_000n;

  const wc = walletClient();
  const pc = publicClient();

  const txHash = await wc.writeContract({
    address: market.pool,
    abi: SPOT_POOL_ABI,
    functionName: "placeOrderFor",
    args: [
      ownerAddress as `0x${string}`,
      isBid,
      0n,           // userData
      price,
      quantity,
      expireNs,
      ORDER_TYPE.IOC,
      0,            // selfMatchingOption: cancel remaining taker
      ZERO_ADDRESS, // no builder
      0n,           // no builder fee
    ],
    chain: SOMNIA_CHAIN,
    account: wc.account!,
    gas: GAS_LIMIT_PER_ORDER,
    maxFeePerGas: 10_000_000_000n,       // 10 gwei ceiling
    maxPriorityFeePerGas: 100_000_000n,  // 0.1 gwei priority
  });

  const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    const err = new Error(`tx reverted on-chain: ${txHash}`);
    (err as any).txHash = txHash; // preserve tx hash for diagnostics
    throw err;
  }
  return txHash;
}

export function resetOperatorClients(): void {
  _walletClient = null;
  _publicClient = null;
}
