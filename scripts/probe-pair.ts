/* eslint-disable no-console */
/**
 * PROBE: does a same-wallet BUY_YES maker + BUY_NO IOC cross as a mint-a-pair,
 * or does the engine reject it as a self-match?
 *
 * If the BUY_NO fills beside the resting BUY_YES, ONE whitelisted key can place
 * BOTH real sides of a round ("two opposite-side buyers cross with no seller":
 * https://docs.dreamdex.io/developers/event-contracts/market-structure), which
 * makes the DreamDuel stake loop work without a second wallet.
 *
 *   npx tsx scripts/probe-pair.ts
 */
import { marketCreatorEventsAbi } from "../node_modules/@somnia-chain/markets-sdk/dist/eventsAbi.js";
import { EC_ADDRESSES } from "../src/lib/ec/config";
import { publicClient } from "../src/lib/ec/staker";
import { ecExchange } from "../src/lib/ec/executor";

async function loadEnv(): Promise<Record<string, string>> {
  const { existsSync, readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const out: Record<string, string> = {};
  for (const file of [".env.local", ".env"]) {
    try {
      const p = resolve(process.cwd(), file);
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const key = m[1];
        const val = m[2].trim().replace(/^["']|["']$/g, "");
        if (!out[key]) out[key] = val;
      }
    } catch { /* ignore */ }
  }
  return out;
}

const expiryInNs = (secsFromNow: number) => (BigInt(Math.floor(Date.now() / 1000)) + BigInt(secsFromNow)) * 1_000_000_000n;

(async () => {
  const env = await loadEnv();
  const pk = env.OPERATOR_PRIVATE_KEY as string;
  process.env.OPERATOR_PRIVATE_KEY = pk;
  const pc = publicClient();
  const exchange = ecExchange();
  const trader = exchange.client.createTrader({ privateKey: pk as `0x${string}` });

  // 1) Discover live windows, pick the soonest one that is still Trading.
  const marketCreated = marketCreatorEventsAbi.find((e) => e.name === "MarketCreated");
  const now = Math.floor(Date.now() / 1000);
  const head = await pc.getBlockNumber();
  const all: any[] = [];
  for (let i = 0; i < 40; i++) {
    const to = head - BigInt(i * 1000);
    try {
      const logs = await pc.getLogs({ event: marketCreated, fromBlock: to - 999n, toBlock: to });
      all.push(...logs.map((l) => l.args));
    } catch { /* best-effort */ }
  }
  const collateral = (EC_ADDRESSES.collateral as string).toLowerCase();
  const live = all
    .filter((m) => Number(m.expiry) > now + 300 && (m.collateral as string)?.toLowerCase() === collateral)
    .sort((a, b) => Number(a.expiry) - Number(b.expiry));
  const w = live[0];
  if (!w) { console.log("no live window in the last 40k blocks"); process.exit(0); }
  console.log(`window ${w.asset} expiry in ${(Number(w.expiry) - now)}s pool=${w.pool}`);

  // Price WELL below the touch so BUY_YES PostOnly rests no matter the live book,
  // and the only thing BUY_NO can cross is that own resting BUY_YES (mint-a-pair).
  const pPrice = 0.05; // 50000 raw / 1e6, 50 ticks, on the 0.001 testnet grid
  console.log("pair price", pPrice, "PER SIDE (both legs sum to 1.00)");

  const Q = 1_000_000n; // 1 whole contract each side (testnet lot = 1e6)
  const makerHash = await (async () => {
    try {
      const m = await trader.placeOrder({
        pool: w.pool,
        side: "BUY_YES",
        price: BigInt(Math.round(pPrice * 1e6)),
        quantity: Q,
        orderType: 3,
        expireTimestampNs: expiryInNs(600),
      });
      console.log("BUY_YES PostOnly ok", m.hash, "fills", JSON.stringify((m.fills ?? []).map((f: any) => ({ side: f.side, qty: String(f.quantityFilled), px: String(f.fillPrice) }))));
      return m.hash;
    } catch (e: any) {
      console.log("BUY_YES PostOnly err:", String(e.message ?? e).split("\n")[0].slice(0, 160));
      return null;
    }
  })();
  if (!makerHash) { console.log("could not rest BUY_YES"); process.exit(1); }

  // 3) IOC BUY_NO at the same price — does it mint-a-pair against our own resting
  //    BUY_YES, or come back SelfMatchCancelTaker?
  try {
    const t = await trader.placeOrder({
      pool: w.pool,
      side: "BUY_NO",
      price: BigInt(Math.round(pPrice * 1e6)),
      quantity: Q,
      orderType: 2,
      expireTimestampNs: expiryInNs(600),
    });
    console.log("BUY_NO IOC ok", t.hash, "\n  fills:", JSON.stringify((t.fills ?? []).map((f: any) => ({ side: f.side, qty: String(f.quantityFilled), px: String(f.fillPrice) })), null, 2));
    console.log("\n>>> VERDICT: SAME-WALLET MINT-A-PAIR WORKS (one key can place both real sides)");
  } catch (e: any) {
    const msg = String(e.message ?? e);
    console.log("BUY_NO IOC err:", msg.split("\n")[0].slice(0, 160));
    console.log("\n>>> VERDICT:", msg.includes("SelfMatch") ? "SAME-WALLET SELF-MATCH BLOCKED (need a 2nd whitelisted key)" : "OTHER ERROR");
  }
  process.exit(0);
})().catch((e) => { console.error("probe crashed:", e); process.exit(1); });