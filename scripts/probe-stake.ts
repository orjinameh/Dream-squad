import { createPublicClient, http, encodeFunctionData, parseAbi, formatUnits } from "viem";
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { EC_ADDRESSES, EC_CHAIN, EC_INDEXER_URL, EC_RPC_WS_URL } from "../src/lib/ec/config";

const exchange = new SomniaMarkets({ indexerUrl: EC_INDEXER_URL, chain: EC_CHAIN, wsRpcUrl: EC_RPC_WS_URL, addresses: EC_ADDRESSES });
const pc = createPublicClient({ chain: EC_CHAIN, transport: http("https://dream-rpc.somnia.network") });

const PLAYER = "0xdd68998C099f7570E59019ae35469E5603cEDA11"; // operator EOA has tUSDC
const ABI = parseAbi([
  "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
  "function getBinaryPoolParams() view returns (address outcomeToken, address token, uint128 yesId, uint128 noId, uint256 minQuantity, uint256 lotSize, uint256 tickSize, uint256 expiryNs, uint8 mode)",
  "function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)",
]);

async function topBook(pool: `0x${string}`): Promise<{ bid: number; ask: number } | null> {
  const sel = (name: string) => encodeFunctionData({ abi: ABI, functionName: name, args: [] });
  // orderbook via indexer for this pool's market is complex; use the unified exchange book instead via symbol below
  return null;
}

try {
  await exchange.loadMarkets(true);
  const now = Math.floor(Date.now() / 1000);
  const live = Object.values(exchange.markets)
    .filter((m) => m.type === "binary" && /^BTC-/.test(m.symbol) && !m.symbol.includes("-0-"))
    .map((m) => ({ m, expiry: Number((m.info as any)?.expiry ?? 0) }))
    .filter((x) => x.expiry > now)
    .sort((a, b) => a.expiry - b.expiry);
  const target = live[0];
  if (!target) { console.log("no live window"); process.exit(0); }
  const m = target.m;
  const oc = await exchange.client.getMarketOnchain(m.id as `0x${string}`);
  const pool = oc.pool as `0x${string}`;
  const book = await exchange.fetchOrderBook(m.symbol, 1);
  const bidRaw = book.bids[0]?.[0];
  const askRaw = book.asks[0]?.[0];
  console.log(`live ${m.symbol} pool=${pool} ask=${(askRaw ?? 0) * 1e6} bid=${(bidRaw ?? 0) * 1e6} expiry=${target.expiry} (+${target.expiry - now}s)`);

  const params = (await pc.readContract({ address: pool, abi: ABI, functionName: "getBinaryPoolParams" })) as any;
  const [outcomeToken, token, yesId, noId, minQuantity, lotSize, tickSize, expiryNs, mode] = params;
  console.log(`params: minQty=${formatUnits(minQuantity, 6)} lot=${formatUnits(lotSize, 6)} tick=${formatUnits(tickSize, 6)} expiryNs=${expiryNs} mode=${mode}`);

  for (const side of ["BUY_YES", "BUY_NO"] as const) {
    const kind = side === "BUY_YES" ? 0 : 2;
    const reference = side === "BUY_YES" ? askRaw : 1 - bidRaw; // outcome-term protective reference: ask for YES, NO ask in NO terms from bid
    if (reference == null) { console.log(`${side}: no book, skip`); continue; }
    const protective = Math.min(0.999, reference + reference * 0.03); // outcome-term limit
    const rawPrice = side === "BUY_YES" ? BigInt(Math.round(protective * 1e6)) : BigInt(Math.round((1 - protective) * 1e6));
    const effectivePrice = side === "BUY_YES" ? protective : 1 - (1 - protective);
    const quantity = BigInt(Math.floor((1e6) / effectivePrice)); // ~$1 of outcome tokens
    const expireNs = (BigInt(target.expiry) * 1_000_000_000n);
    const data = encodeFunctionData({
      abi: ABI, functionName: "placeBinaryOrder",
      args: [kind, rawPrice, quantity, expireNs, 2, 0, "0x0000000000000000000000000000000000000000", 0n, 0n],
    });
    console.log(`${side}: kind=${kind} price=${rawPrice} qty=${quantity} expireNs=${expireNs}`);
    const res = await pc.call({ account: PLAYER as `0x${string}`, to: pool, data }).catch((e) => e);
    if (res && (res.data || res.status === "success" || res.success)) {
      console.log(`${side}: CALL OK${res.data ? " status ok" : ""}`);
    } else {
      console.log(`${side}: REVERT reason=${(res as Error)?.shortMessage ?? (res as any)?.message ?? JSON.stringify(res).slice(0, 200)}`);
    }
    const bal = await pc.readContract({ address: token as `0x${string}`, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [PLAYER as `0x${string}`] }).catch(() => null);
    console.log(`tUSDC balance: ${bal == null ? "-" : formatUnits(bal as bigint, 6)}`);
  }
  process.exit(0);
} catch (err) {
  console.error("PROBE FAILED", (err as Error).message);
  process.exit(1);
}