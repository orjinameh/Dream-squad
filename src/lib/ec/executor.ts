import { createPublicClient, http, defineChain } from "viem";
import { SomniaMarkets, upProbability, type MarketOnchain, type UnifiedMarket, type BinaryMarket } from "@somnia-chain/markets-sdk";
import {
  EC_ADDRESSES, EC_CHAIN, EC_CHAIN_ID, EC_INDEXER_URL, EC_RPC_URL, EC_RPC_WS_URL,
  EC_COLLATERAL_DECIMALS, ecHttpTransport,
} from "./config";

/**
 * DreamDEX Event Contract (binary YES/NO) access for DreamDuel.
 *
 * Event-Contract pools gate operators via `OnlyApprovedContracts` — an ordinary
 * EOA (our backend) cannot place orders on them for anyone. So the EC layer here
 * is the REAL Oracle + settlement anchor, not a per-player trading path:
 *
 *   - RESOLVE the active BTC/ETH binary market (the "arena floor") with its real
 *     strike + expiry.
 *   - ORACLE the live YES/NO price from the market's real order book — the feed
 *     every match round is resolved against.
 *   - READ on-chain collateral / outcome balances and post-settlement state.
 *
 * Financial settlement of a match's prize pot is handled by the DreamDuel escrow
 * contract (a real on-chain tUSDC vault), not by this module.
 */

const RPC_URL = process.env.SOMNIA_RPC_URL ?? EC_RPC_URL;

let _exchange: SomniaMarkets | null = null;
let _publicClient: ReturnType<typeof createPublicClient> | null = null;

export function ecExchange(): SomniaMarkets {
  if (_exchange) return _exchange;
  _exchange = new SomniaMarkets({
    indexerUrl: EC_INDEXER_URL,
    chain: EC_CHAIN,
    wsRpcUrl: EC_RPC_WS_URL,
    addresses: EC_ADDRESSES,
  });
  return _exchange;
}

export function ecPublicClient() {
  if (_publicClient) return _publicClient;
  // Post-reorder, webSocket[...]/http[0] of EC_CHAIN is the reliable mirror;
  // the fallback transport keeps all three mirrors warm for the rest.
  _publicClient = createPublicClient({
    chain: EC_CHAIN,
    transport: process.env.SOMNIA_RPC_URL ? http(RPC_URL) : ecHttpTransport(),
  });
  return _publicClient;
}

// ─── Arena floor: the active market window ──────────────────────────────────

export interface EcArenaMarket {
  symbol: string; // e.g. "BTC-7812345-30AUG26-1200/tUSDC"
  marketId: string;
  pool: `0x${string}`;
  collateral: `0x${string}`;
  token: `0x${string}`; // ERC-6909 outcome-token singleton
  yesId: bigint;
  noId: bigint;
  strike: string;
  decimals: number;
  expiry: number; // unix seconds
}

/**
 * Resolve the currently-trading binary market for an asset ("BTC"|"ETH") that
 * has a REAL strike (not the "ETH-0-" placeholder the venue lists for rolling
 * liquidity) and a future expiry. The venue rolls real-strike windows roughly
 * every minute, so one is essentially always live; the soonest-settling window
 * is picked so the position resolves ~a minute after opening. Returns null when
 * only zero-strike placeholder windows remain (503 — try again in a moment).
 *
 * NOTE: zero-strike "ETH-0-" windows are deliberately skipped: the venue never
 * resolves them (isResolved stays false forever), so a position anchored to one
 * could NEVER settle — it would lock the player's tUSDC indefinitely.
 */
// ─── In-process arena cache ─────────────────────────────────────────────────
// The arena floor is discovered via a full indexer sweep (`listRegistryMarkets`
// pages every spot/perp/live-binary market + reads ERC-20 metadata on-chain).
// That sweep is heavy and repeatedly exceeds the Vercel serverless budget
// ("RegistryMarkets failed: operation aborted due to timeout") when every match
// round and every position call re-runs it. The venue rolls binary windows about
// once a minute, so caching the floor for ARENA_CACHE_TTL_MS (well under a
// window life) is safe: it never pins a stale window for long, while collapsing
// the overwhelming majority of concurrent/repeated sweeps. The fallback keeps a
// last-known-good floor so a transient indexer timeout degrades to "reuse the
// last live arena" instead of a hard failure / no-op round.
const ARENA_CACHE_TTL_MS = 30_000;
const ARENA_FALLBACK_TTL_MS = 5 * 60_000;
/** Per-request ceiling (ms) for the indexer sweep inside Vercel serverless. */
const ARENA_SWEEP_TIMEOUT_MS = 8_000;
const MIN_EC_BOOK_SPREAD = 1e-4;

interface ArenaCacheEntry {
  floor: EcArenaMarket | null;
  at: number;
}
const arenaCache = new Map<"BTC" | "ETH", ArenaCacheEntry>();
const arenaSweepInFlight = new Map<"BTC" | "ETH", Promise<EcArenaMarket | null>>();

function cachedArena(asset: "BTC" | "ETH", nowMs: number): ArenaCacheEntry | undefined {
  const e = arenaCache.get(asset);
  if (!e) return undefined;
  if (nowMs - e.at < ARENA_CACHE_TTL_MS) return e;
  return undefined;
}

export async function findArenaFloor(
  asset: "BTC" | "ETH",
  minLeftSec = 0,
  opts: { preferBook?: boolean } = {},
): Promise<EcArenaMarket | null> {
  if (asset !== "BTC" && asset !== "ETH") return null;
  const nowMs = Date.now();
  const cached = cachedArena(asset, nowMs);
  // Serve the cached floor for ANY minLeftSec when it still has enough life left
  // (so the (asset, 30) preferred-call is also a cache hit, not just the (0)
  // fallback). The cached floor carries an `expiry`, so align on its remaining
  // life rather than assuming the caller's requested margin matches the cache.
  if (cached?.floor) {
    const leftSec = Number(cached.floor.expiry) - Math.floor(nowMs / 1000);
    if (leftSec >= minLeftSec) return cached.floor;
  }

  // If the sweep is already running for this asset, join it instead of firing a
  // second (heavy) one — concurrent matches/positions share a single indexer call.
  const inFlight = arenaSweepInFlight.get(asset);
  if (inFlight) {
    try { return await inFlight; }
    finally { if (arenaSweepInFlight.get(asset) === inFlight) arenaSweepInFlight.delete(asset); }
  }

  const sweep = sweepArenaFloor(asset, minLeftSec, nowMs, opts);
  arenaSweepInFlight.set(asset, sweep);
  try {
    const floor = await sweep;
    // Only remember a live floor. A null ("no live window right now") shouldn't
    // be served as a cache hit, and must not evict a good floor that the fallback
    // can still reuse.
    if (floor) arenaCache.set(asset, { floor, at: Date.now() });
    return floor;
  } finally {
    if (arenaSweepInFlight.get(asset) === sweep) arenaSweepInFlight.delete(asset);
  }
}

async function sweepArenaFloor(asset: "BTC" | "ETH", minLeftSec: number, nowMs: number, opts: { preferBook?: boolean }): Promise<EcArenaMarket | null> {
  // Bind the sweep to a generous-but-bounded timeout so a slow/hung indexer
  // degrades gracefully inside the Vercel serverless budget instead of letting
  // the SDK's 30s GraphQL timeout blow the function's own limit.
  let timer: NodeJS.Timeout | undefined;
  const withBudget = <T,>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`arena sweep timed out after ${ARENA_SWEEP_TIMEOUT_MS}ms`)), ARENA_SWEEP_TIMEOUT_MS);
      p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });

  const fresh = await withBudget(discoverArenaFloor(asset, minLeftSec, Math.floor(nowMs / 1000), opts))
    .catch((err) => {
      console.warn(`[arena] sweep failed for ${asset}: ${err instanceof Error ? err.message : String(err)} — falling back to last good floor`);
      return null;
    });
  if (fresh) return fresh;

  // Fallback: reuse the last non-null floor known this process, even if its
  // cache entry aged out, so a transient indexer outage doesn't kill the round.
  const lastGood = arenaCache.get(asset)?.floor;
  if (lastGood && nowMs - (arenaCache.get(asset)?.at ?? 0) < ARENA_FALLBACK_TTL_MS) {
    return lastGood;
  }
  return null;
}

async function discoverArenaFloor(asset: "BTC" | "ETH", minLeftSec: number, now: number, opts: { preferBook?: boolean }): Promise<EcArenaMarket | null> {
  // Combat rounds resolve off the live order book — the ONLY thing that gives
  // a moving mid. That path runs entirely over the indexer HTTP API (no heavy
  // loadMarkets sweep, no flaky WebSocket), which keeps serverless cold starts
  // and every round inside budget. The POSITION flow (preferBook=false) needs
  // formal settlement, so it keeps the full SDK discovery (real-strike windows).
  if (opts.preferBook) return discoverLiquidArena(asset, minLeftSec, now);
  return discoverSettlingArena(asset, minLeftSec, now);
}

/**
 * Light, indexer-HTTP-only arena discovery for combat rounds. `listLiveBinaryMarkets`
 * returns every future-expiry binary window in ~300ms; among the soonest ones we
 * pick the first with a real two-sided order book (the venue's liquid windows).
 * No WebSocket, no per-window on-chain probes — deterministic and fast.
 */
async function discoverLiquidArena(asset: "BTC" | "ETH", minLeftSec: number, now: number): Promise<EcArenaMarket | null> {
  const exchange = ecExchange();
  try {
    await exchange.loadMarkets(false);
  } catch {
    /* registry read failed — fall through to symbol-less indexer book below */
  }

  const live = await listLiquidWindows(asset);
  const rows = live
    .filter((m) => !m.finalized && !m.voided && Number(m.expiry) > now + minLeftSec)
    .sort((a, b) => Number(a.expiry) - Number(b.expiry));

  for (const r of rows.slice(0, 6)) {
    const market = Object.values(exchange.markets).find((um) => um.id === r.marketId);
    const arena: EcArenaMarket = {
      symbol: market?.symbol ?? `${asset}-${r.strike ?? "0"}-liquid/tUSDC`,
      marketId: r.marketId,
      pool: (r.poolAddress ?? EC_ADDRESSES.collateral ?? "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E") as `0x${string}`,
      collateral: (r.collateral ?? EC_ADDRESSES.collateral ?? "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E") as `0x${string}`,
      token: (r.collateral ?? EC_ADDRESSES.collateral ?? "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E") as `0x${string}`,
      yesId: r.yesTokenId != null ? BigInt(String(r.yesTokenId)) : 0n,
      noId: r.noTokenId != null ? BigInt(String(r.noTokenId)) : 0n,
      strike: String(r.strike ?? ""),
      decimals: EC_COLLATERAL_DECIMALS,
      expiry: Number(r.expiry),
    };
    const q = await readArenaPrice(arena);
    if (q.bestBid != null && q.bestAsk != null && q.yesPrice != null && q.yesPrice > 0) {
      return arena;
    }
  }
  return null;
}

interface LiquidWindow {
  marketId: string;
  poolAddress: `0x${string}` | null;
  collateral: `0x${string}` | null;
  yesTokenId: string | number | null;
  noTokenId: string | number | null;
  strike: string | number | null;
  expiry: string | number;
  finalized: boolean;
  voided: boolean;
}

/**
 * Future-expiry binary windows for an asset, straight from the indexer GraphQL
 * (mirrors the SDK's `listLiveBinaryMarkets` query but returns only the fields
 * round-arena selection needs). Pure HTTP, ~300ms — no WebSocket, no heavy
 * `loadMarkets` registry sweep.
 */
async function listLiquidWindows(asset: string): Promise<LiquidWindow[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const query = `
    query LiveWindows {
      Market(where: {marketType: {_eq: "BINARY"}, expiry: {_gt: "${nowSec}"}, asset: {_eq: "${asset}"}}, order_by: {expiry: asc}, limit: 40) {
        marketId poolAddress collateral yesTokenId noTokenId strike expiry finalized voided
      }
    }`;
  try {
    const res = await fetch(EC_INDEXER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(8_000),
    });
    const json = await res.json() as { data?: { Market?: LiquidWindow[] } };
    return json.data?.Market ?? [];
  } catch {
    return [];
  }
}

async function discoverSettlingArena(asset: "BTC" | "ETH", minLeftSec: number, now: number): Promise<EcArenaMarket | null> {
  const prefix = asset === "BTC" ? "BTC-" : "ETH-";
  const exchange = ecExchange();

  let markets: UnifiedMarket[] = Object.values(exchange.markets ?? {});
  if (markets.length === 0) {
    markets = Object.values(await exchange.loadMarkets(true));
  }

  // Cheap indexer-side pre-filter: only near-future windows. This bounds the
  // expensive per-market on-chain probe to the handful of windows potentially
  // live (the venue keeps rolling fresh ones), instead of RPC-probing all
  // historical windows on every call (that blew past serverless timeouts).
  const candidates = markets.filter((m) => {
    if (m.type !== "binary") return false;
    if (!m.symbol.startsWith(prefix)) return false;
    // Zero-strike windows NEVER settle on-chain, so positions (which settle
    // against the formal winningOutcome) must skip them.
    if (m.symbol.includes("-0-")) return false;
    const info = m.info as BinaryMarket & { expiry?: string | number };
    return Boolean(info.expiry) && Number(info.expiry) > now + minLeftSec;
  });

  // Probe every candidate IN PARALLEL, each with a hard per-probe timeout and
  // one retry. The SDK's on-chain reads ride its WebSocket client, which is
  // flaky on testnet — a sequential loop of 1-3s WS reads blew the 8s sweep
  // budget and returned no arena (every round then fell back to FLAT). Parallel
  // probes with retry keep the sweep inside budget even when a probe stalls.
  const PROBE_TIMEOUT_MS = 3_500;
  const probeOnchain = async (id: string): Promise<MarketOnchain | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await Promise.race([
          exchange.client.getMarketOnchain(id as `0x${string}`),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("onchain probe timed out")), PROBE_TIMEOUT_MS),
          ),
        ]);
      } catch {
        /* retry once; give up after */
      }
    }
    return null;
  };

  const results = await Promise.all(
    candidates.map(async (m) => ({ m, onchain: await probeOnchain(m.id as string) })),
  );

  const floors: EcArenaMarket[] = [];
  for (const { m, onchain } of results) {
    if (!onchain) continue;
    if (onchain.status !== 1 || onchain.isResolved) continue; // only live + unsettled
    if (!onchain.expiry || Number(onchain.expiry) <= now) continue;
    const leftSec = Number(onchain.expiry) - now;
    if (leftSec < minLeftSec) continue;
    const info = m.info as BinaryMarket & { expiry?: string | number };
    floors.push({
      symbol: m.symbol,
      marketId: m.id,
      pool: onchain.pool,
      collateral: onchain.collateral ?? EC_ADDRESSES.collateral,
      token: onchain.outcomeToken ?? EC_ADDRESSES.collateral,
      yesId: onchain.yesId,
      noId: onchain.noId,
      strike: info.strike ?? "",
      decimals: onchain.decimals,
      expiry: Number(onchain.expiry),
    });
  }

  if (floors.length === 0) return null;
  floors.sort((a, b) => a.expiry - b.expiry);
  // Soonest-settling window so the position resolves shortly after opening.
  return floors[0];
}

// ─── Live YES price oracle (real order book) ────────────────────────────────

export interface EcPriceQuote {
  yesPrice: number | null; // human probability in (0,1): 0.5 = 50/50
  bestBid: number | null;
  bestAsk: number | null;
  updatedMs: number;
}

/**
 * Read the live price of the arena's YES token straight from the market's real
 * order book (mid of best bid/ask). This is the oracle every round resolves on.
 * Returns nulls when the book has no two-sided depth yet.
 *
 * PRIMARY source is the indexer's resting-order table (`Order`) read over plain
 * HTTP by marketId — fast, deterministic, immune to the WebSocket flakiness and
 * the heavy loadMarkets sweep needed by the SDK's fetchOrderBook. Falls back to
 * `fetchOrderBook(symbol)` when the marketId path has no two-sided book.
 */
export async function readArenaPrice(arena: EcArenaMarket): Promise<EcPriceQuote> {
  const exchange = ecExchange();
  // The SDK's unified fetchOrderBook reads the venue's LIVE store for the market
  // behind `symbol` — the price the venue actually trades at. Prefer it; fall
  // back to the indexer's resting-order table when this symbol isn't registered
  // (a rolling window the registry hasn't picked up yet).
  try {
    const book = await exchange.fetchOrderBook(arena.symbol, 1);
    const bestBid = book.bids[0]?.[0] ?? null;
    const bestAsk = book.asks[0]?.[0] ?? null;
    if (bestBid != null && bestAsk != null && bestAsk - bestBid >= MIN_EC_BOOK_SPREAD) {
      return {
        yesPrice: (bestBid + bestAsk) / 2,
        bestBid,
        bestAsk,
        updatedMs: Date.now(),
      };
    }
  } catch {
    /* symbol not registered — try the indexer book below */
  }
  if (arena.marketId) {
    const book = await topOfBook(arena.marketId);
    // Only REAL two-sided depth counts: require a genuine (non-hairline) spread so
    // stale sub-bps resting rows don't surface as a frozen 0.5000 "quote".
    if (book && book.ask - book.bid >= MIN_EC_BOOK_SPREAD) {
      return {
        yesPrice: (book.bid + book.ask) / 2,
        bestBid: book.bid,
        bestAsk: book.ask,
        updatedMs: Date.now(),
      };
    }
  }
  return { yesPrice: null, bestBid: null, bestAsk: null, updatedMs: Date.now() };
}

/**
 * Best bid/ask straight from the indexer's RESTING-ORDER table, by marketId.
 * Order prices are collateral-scaled (tUSDC 6dp: price 954000 == 0.954 YES).
 * Surfaces the real top-of-book without any SDK/realtime/WebSocket dependency.
 */
async function topOfBook(marketId: string): Promise<{ bid: number; ask: number } | null> {
  const safe = marketId.toLowerCase();
  const query = `
    query {
      bids: Order(where: {market_id: {_eq: "${safe}"}, isBid: {_eq: true}, quantityRemaining: {_gt: "0"}}, order_by: {price: desc}, limit: 1) { price }
      asks: Order(where: {market_id: {_eq: "${safe}"}, isBid: {_eq: false}, quantityRemaining: {_gt: "0"}}, order_by: {price: asc}, limit: 1) { price }
    }`;
  try {
    const res = await fetch(EC_INDEXER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(6_000),
    });
    const json = await res.json() as { data?: { bids?: { price: string }[]; asks?: { price: string }[] } };
    const bidRaw = json.data?.bids?.[0]?.price;
    const askRaw = json.data?.asks?.[0]?.price;
    if (bidRaw == null || askRaw == null) return null;
    const bid = Number(bidRaw) / 1_000_000;
    const ask = Number(askRaw) / 1_000_000;
    if (!(bid > 0) || !(ask > 0) || bid >= ask) return null;
    return { bid, ask };
  } catch {
    return null;
  }
}

/** Raw YES balance → human probability (0..1). */
export function yesToProbability(rawYes: bigint | string | null | undefined, decimals?: number): number | null {
  return upProbability(rawYes, decimals ?? EC_COLLATERAL_DECIMALS);
}

// ─── On-chain settlement reads ──────────────────────────────────────────────

export interface EcAccountBalances {
  collateral: bigint; // tUSDC (6 dp) held in the wallet
  yes: bigint; // YES outcome tokens held
  no: bigint; // NO outcome tokens held
  decimals: number;
}

export async function readArenaBalances(addr: string, arena: EcArenaMarket): Promise<EcAccountBalances> {
  const exchange = ecExchange();
  const client = exchange.client;
  const [yes, no, collateral] = await Promise.all([
    client
      .getOutcomeBalance({ outcomeToken: arena.token, account: addr as `0x${string}`, id: arena.yesId })
      .catch(() => 0n),
    client
      .getOutcomeBalance({ outcomeToken: arena.token, account: addr as `0x${string}`, id: arena.noId })
      .catch(() => 0n),
    client.getErc20Balance(arena.collateral, addr as `0x${string}`).catch(() => 0n),
  ]);
  return { collateral, yes, no, decimals: arena.decimals };
}

/**
 * Read the on-chain state of the arena floor after (or before) settlement.
 * `isResolved` is the binary settlement flag; `winningOutcome` is 0=YES / 1=NO.
 * Uses the marketId (NOT the pool address — getMarketOnchain keys on marketId).
 */
export async function readArenaSettlement(arena: EcArenaMarket): Promise<{
  isResolved: boolean;
  winningOutcome: number;
  status: number;
}> {
  const exchange = ecExchange();
  if (!arena.marketId) return { isResolved: false, winningOutcome: 0, status: 0 };
  try {
    const oc = await exchange.client.getMarketOnchain(arena.marketId as `0x${string}`);
    return {
      isResolved: oc.isResolved,
      winningOutcome: Number(oc.winningOutcome ?? 0),
      status: oc.status,
    };
  } catch {
    return { isResolved: false, winningOutcome: 0, status: 0 };
  }
}

export { EC_COLLATERAL_DECIMALS };
