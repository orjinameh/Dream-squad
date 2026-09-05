import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { EC_ADDRESSES, EC_CHAIN, EC_INDEXER_URL, EC_RPC_WS_URL } from "../src/lib/ec/config";

const exchange = new SomniaMarkets({
  indexerUrl: EC_INDEXER_URL,
  chain: EC_CHAIN,
  wsRpcUrl: EC_RPC_WS_URL,
  addresses: EC_ADDRESSES,
});
const client = exchange.client;

function winLabel(win: number | null | undefined): string {
  if (win == null) return "null";
  return win === 0 ? "UP(YES)" : win === 1 ? "DOWN(NO)" : `?${win}`;
}

try {
  await exchange.loadMarkets(true);
  const markets = Object.values(exchange.markets);
  const binaries = markets.filter((m) => m.type === "binary" && /^BTC-/.test(m.symbol) && !m.symbol.includes("-0-"));
  console.log(`total markets: ${markets.length}, real BTC binaries: ${binaries.length}`);

  const now = Math.floor(Date.now() / 1000);
  const sorted = binaries
    .map((m) => ({ m, expiry: Number((m.info as any)?.expiry ?? 0) }))
    .sort((a, b) => Math.abs(a.expiry - now) - Math.abs(b.expiry - now));

  for (const { m, expiry } of sorted.slice(0, 12)) {
    const past = expiry < now;
    let ocRec: string;
    try {
      const oc = await client.getMarketOnchain(m.id as `0x${string}`);
      ocRec = `st=${oc.status} resolved=${!!oc.isResolved} winner=${winLabel(oc.winningOutcome)} pool=${String(oc.pool).slice(0, 8)}`;
    } catch (e) {
      ocRec = `onchain-err: ${(e as Error).message.slice(0, 50)}`;
    }
    let resRec: string;
    try {
      const res = await client.getMarketResolution(m.id as `0x${string}`, EC_INDEXER_URL);
      const ev = res.events.at(-1);
      resRec = `events=${res.events.length} last=${ev?.kind ?? "-"} winner=${winLabel((ev as any)?.winningOutcome)} opening=${res.openingAnswer?.numericValue ?? "-"} closing=${res.closingAnswer?.numericValue ?? "-"}`;
    } catch (e) {
      resRec = `res-err: ${(e as Error).message.slice(0, 50)}`;
    }
    console.log(`${past ? "PAST " : "LIVE "} exp=${expiry} (+${expiry - now}s) ${m.symbol}  ||  ${ocRec}  ||  ${resRec}`);
  }
  process.exit(0);
} catch (err) {
  console.error("PROBE FAILED", (err as Error).message);
  process.exit(1);
}