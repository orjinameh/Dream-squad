import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { EC_ADDRESSES, EC_CHAIN, EC_INDEXER_URL, EC_RPC_WS_URL } from "../src/lib/ec/config";

const exchange = new SomniaMarkets({
  indexerUrl: EC_INDEXER_URL,
  chain: EC_CHAIN,
  wsRpcUrl: EC_RPC_WS_URL,
  addresses: EC_ADDRESSES,
});
const client = exchange.client;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const win = (o: number | null | undefined) => (o == null ? "null" : o === 0 ? "UP(YES)" : o === 1 ? "DOWN(NO)" : "?" + o);

try {
  await exchange.loadMarkets(true);
  const binaries = Object.values(exchange.markets).filter((m) => m.type === "binary" && /^BTC-/.test(m.symbol) && !m.symbol.includes("-0-"));
  const now = Math.floor(Date.now() / 1000);
  const live = binaries
    .map((m) => ({ m, expiry: Number((m.info as any)?.expiry ?? 0) }))
    .filter((x) => x.expiry > now)
    .sort((a, b) => a.expiry - b.expiry);

  if (live.length === 0) {
    console.log("no live BTC window right now");
    process.exit(0);
  }
  const target = live[0];
  const exp = target.expiry;
  const id = target.m.id as `0x${string}`;
  console.log(`watching ${target.m.symbol} id=${id} expires at ${exp} (+${exp - now}s)`);

  let midAtOpen = "?";
  try {
    const book = await exchange.fetchOrderBook(target.m.symbol, 1);
    const b = book.bids[0]?.[0];
    const a = book.asks[0]?.[0];
    if (b != null && a != null) midAtOpen = `mid=${(((b + a) / 2) * 1e6).toFixed(0)} bid${(b * 1e6).toFixed(0)} ask${(a * 1e6).toFixed(0)}`;
  } catch {}

  const start = Date.now();
  while (Date.now() - start < 200_000) {
    await sleep(4000);
    let midNow = "?";
    try {
      const book = await exchange.fetchOrderBook(target.m.symbol, 1);
      const b = book.bids[0]?.[0];
      const a = book.asks[0]?.[0];
      if (b != null && a != null) midNow = `mid=${(((b + a) / 2) * 1e6).toFixed(0)}`;
    } catch {}
    let ocRec: string;
    try {
      const oc = await client.getMarketOnchain(id);
      ocRec = `st=${oc.status} resolved=${!!oc.isResolved} winner=${win(oc.winningOutcome)} num=${(oc as any).payoutNumerators ?? "-"}`;
    } catch (e) {
      ocRec = "onchain-err " + (e as Error).message.slice(0, 40);
    }
    let evRec: string;
    try {
      const res = await client.getMarketResolution(id, EC_INDEXER_URL);
      const ev = res.events.at(-1);
      evRec = `events=${res.events.length} kind=${ev?.kind ?? "-"} winner=${win((ev as any)?.winningOutcome)} open=${res.openingAnswer?.numericValue ?? "-"} close=${res.closingAnswer?.numericValue ?? "-"}`;
    } catch (e) {
      evRec = "res-err " + (e as Error).message.slice(0, 40);
    }
    console.log(`t+${Math.round((Date.now() - start) / 1000)}s ${midNow} || ${ocRec} || ${evRec}`);
    const oc = () => client.getMarketOnchain(id).then((o) => !!o.isResolved).catch(() => false);
    if (await oc()) {
      console.log(`RESOLVED at t+${Math.round((Date.now() - start) / 1000)}s (opened mid: ${midAtOpen})`);
      break;
    }
  }
  console.log("watch done");
  process.exit(0);
} catch (err) {
  console.error("PROBE FAILED", (err as Error).message);
  process.exit(1);
}