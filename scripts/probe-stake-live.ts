/* eslint-disable no-console */
/**
 * PROVE the stake → round → settle → PnL loop on DreamDEX live.
 *
 *   npx tsx scripts/probe-stake-live.ts
 *
 * Uses OPERATOR_PRIVATE_KEY from .env.local — the whitelisted house/player
 * wallet (testnet tUSDC can only be moved by whitelisted keys, so the operator
 * custodies round stakes — the realistic game model on this testnet).
 *
 * Flow — exactly what a DreamDuel round does:
 *   1. Discover the soonest live window (MarketCreated chain logs) with a
 *      two-sided book, pick the shortest one that can fill ~0.4 tUSDC.
 *   2. STAKE  — SDK trader IOC buy of the predicted outcome in that window
 *               (real on-chain position; no maker, so organic liquidity only).
 *   3. ROUND  — after 10s, judge UP|DOWN via resolveArenaOutcome (protocol
 *               winningOutcome if posted, else commit→round-end direction).
 *   4. SETTLE — watch the on-chain window close; print the real winningOutcome
 *               + net PnL, then redeem winning tokens 1:1 for collateral.
 */
import { marketCreatorEventsAbi } from "../node_modules/@somnia-chain/markets-sdk/dist/eventsAbi.js";
import { privateKeyToAccount } from "viem/accounts";
import { EC_ADDRESSES } from "../src/lib/ec/config";
import { readArenaSettlement, resolveArenaOutcome, ecExchange } from "../src/lib/ec/executor";
import { stakePlayerRoundOnDreamDEX, redeemWinningStake, tradePnL, publicClient, faucetCollateral } from "../src/lib/ec/staker";

async function loadEnv(): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...process.env };
  const { existsSync, readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
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

(async () => {
  const env = await loadEnv();
  const pk = env.OPERATOR_PRIVATE_KEY;
  if (!pk) {
    console.log("OPERATOR_PRIVATE_KEY missing. Paste it into .env.local first.");
    process.exit(1);
  }
  process.env.OPERATOR_PRIVATE_KEY = pk;
  const operator = privateKeyToAccount(pk as `0x${string}`);
  console.log(`operator=${operator.address}`);

  // Top up the whitelisted operator wallet if it's dry, then fund STT gas if needed.
  const pc = publicClient();
  const sttBal = await pc.getBalance({ address: operator.address });
  if (Number(sttBal) / 1e18 < 0.5) {
    console.log("operator STT < 0.5 — faucet the key elsewhere first (Telegram SomniaHacks).");
  }
  const house = await faucetCollateral(undefined, 5_000_000n);
  if (house.txHash) {
    await pc.waitForTransactionReceipt({ hash: house.txHash as `0x${string}`, timeout: 60_000 });
    console.log("house   faucet +5 tUSDC");
  } else {
    console.log("house   faucet note:", house.error?.slice(0, 80));
  }

  // 1) Discover live windows from MarketCreated chain logs; prefer ones that can
  //    fill (best ask) — closest to expiry first.
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
    .filter((m) => Number(m.expiry) > now + 600 && (m.collateral as string)?.toLowerCase() === collateral)
    .sort((a, b) => Number(a.expiry) - Number(b.expiry));
  // Prefer windows closing within ~30min (settle demo = quick), else soonest.
  const near = live.filter((m) => Number(m.expiry) <= now + 1800);
  const candidates = (near.length ? near : live).slice(0, 6);
  console.log(`discovered ${live.length} live windows${near.length ? ` (${near.length} closing ≤30m)`: " (none ≤30m)"}`);
  if (!live.length) { console.log("no live window right now — retry in a minute"); process.exit(0); }

  const DEC = 1_000_000n;
  const stakeRaw = 400000n; // 0.4 tUSDC

  // 2a) RESETTLE mode — skip discovery/stake/judge, just watch a previously
  //     staked marketId until the protocol resolves it, then PnL + redeem.
  //     Use after a placement run while its window (minutes out) closes:
  //     RESETTLE_MARKET=<marketId> RESETTLE_ASSET=BTC npx tsx scripts/probe-stake-live.ts
  const resettleId = (env.RESETTLE_MARKET ?? "").trim();
  if (resettleId) {
    const onchain = await ecExchange().client.getMarketOnchain(resettleId as `0x${string}`).catch(() => null);
    if (!onchain) { console.log(`RESETTLE: market ${resettleId} not readable`); process.exit(1); }
    const arena = { marketId: resettleId, pool: onchain.pool, symbol: env.RESETTLE_ASSET ?? "? ", expiry: Math.floor(Date.now() / 1000) + 3600 };
    const qty = BigInt(env.RESETTLE_QTY || "400000");
    const costRaw = BigInt(env.RESETTLE_COST || (stakeRaw)); // default UP@0.5 mint-pair cost
    console.log(`RESETTLE ${arena.symbol} market=${resettleId} qty=${qty} cost=${(Number(costRaw) / 1e6).toFixed(4)} tUSDC — waiting for protocol resolution (~${Math.max(1, arena.expiry - Math.floor(Date.now() / 1000))}s)…`);
    for (let i = 0; i < 3600; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const st = await readArenaSettlement(arena).catch(() => null);
      if (!st?.isResolved) { if (i % 12 === 11) console.log(`still open (${(i + 1) * 5}s)…`); continue; }
      const won = st.winningOutcome === 0; // booked UP (yes=0)
      const pnl = tradePnL(qty, costRaw, won);
      console.log(`RESOLVED winner=${won ? "UP (YES) — WON" : "DOWN (NO) — LOST"}`);
      console.log(`pnl      gross=${(Number(pnl.grossRaw) / 1e6).toFixed(6)} tUSDC  net=${(Number(pnl.netRaw) / 1e6).toFixed(6)} tUSDC`);
      if (won) {
        const settle = await redeemWinningStake(arena.marketId as `0x${string}`, st.winningOutcome, qty);
        console.log(`redeem   ${settle.txHash ? `tx=${settle.txHash}` : `failed: ${settle.error ?? "?"}`}`);
      } else {
        console.log("redeem   n/a — loser's tokens are worth zero");
      }
      process.exit(0);
    }
    console.log("RESETTLE: still not resolved after 5h.");
    process.exit(0);
  }
  let arena: any = null;
  let res: any = null;
  // Mint-a-pair path: the staker prices the round itself when the book is empty
  // (a same-wallet BUY_YES maker + BUY_NO IOC cross with NO seller — verified
  // live), so ONE key posts the player's real position even on a thin window.
  for (const w of candidates) {
    const a = { marketId: w.marketId as string, pool: w.pool as string, symbol: `${w.asset}`, expiry: Number(w.expiry) };
    const r = await stakePlayerRoundOnDreamDEX(a, operator.address, "UP", stakeRaw);
    if (r.txHash) { arena = a; res = r; break; }
    console.log(`window ${a.symbol} in ${Math.max(0, a.expiry - now)}s  no fill (${r.error?.slice(0, 60)}) — next…`);
  }
  if (!arena || !res) { console.log("no window could fill a UP stake right now (thin books) — retry in a minute"); process.exit(0); }
  const costRaw = res.costRaw ?? stakeRaw;
  const qty = res.filledQuantity ?? stakeRaw;
  console.log(`staked   ${arena.symbol} in ${Math.max(0, arena.expiry - now)}s  tx=${res.txHash}  market=${arena.marketId}  side=UP  qty=${qty}  cost=${(Number(costRaw) / 1e6).toFixed(4)} tUSDC`);

  // 3) ROUND — the 10s judge, exactly what a DreamDuel round reads for combat.
  await new Promise((r) => setTimeout(r, 10_000));
  const tenSec = await resolveArenaOutcome(arena, null);
  console.log(`round    T+10s source=${tenSec.source} actual=${tenSec.actual}${tenSec.winningOutcomeRaw != null ? ` winningOutcome=${tenSec.winningOutcomeRaw}` : ""}`);

  // 4) SETTLE — protocol resolution at window close + net PnL + redeem.
  console.log("settle   watching protocol resolution at window close…");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await readArenaSettlement(arena).catch(() => null);
    if (!st?.isResolved) { if (i % 10 === 9) console.log(`still open (${((i + 1) * 5)}s)…`); continue; }
    const won = st.winningOutcome === 0; // we bought YES (up = 0)
    const pnl = tradePnL(qty, costRaw, won);
    console.log(`RESOLVED winner=${won ? "UP (YES) — WON" : "DOWN (NO) — LOST"}`);
    console.log(`pnl      gross=${(Number(pnl.grossRaw) / 1e6).toFixed(6)} tUSDC  net=${(Number(pnl.netRaw) / 1e6).toFixed(6)} tUSDC`);
    if (won) {
      const settle = await redeemWinningStake(arena.marketId as `0x${string}`, st.winningOutcome, qty);
      console.log(`redeem   ${settle.txHash ? `tx=${settle.txHash}` : `failed: ${settle.error ?? "?"}`}`);
    } else {
      console.log("redeem   n/a — loser's tokens are worth zero");
    }
    process.exit(0);
  }
  console.log("window didn't resolve within 5min — oracle grace varies.");
  process.exit(0);
})().catch((e) => { console.error("probe crashed:", e); process.exit(1); });