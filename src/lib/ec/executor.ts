import { createPublicClient, http, defineChain } from "viem";
import { SomniaMarkets, upProbability, type MarketOnchain, type UnifiedMarket, type BinaryMarket } from "@somnia-chain/markets-sdk";
import {
  EC_ADDRESSES, EC_CHAIN, EC_CHAIN_ID, EC_INDEXER_URL, EC_RPC_URL, EC_RPC_WS_URL,
  EC_COLLATERAL_DECIMALS,
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
  _publicClient = createPublicClient({ chain: EC_CHAIN, transport: http(RPC_URL) });
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

  const sweep = sweepArenaFloor(asset, minLeftSec, nowMs);
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

async function sweepArenaFloor(asset: "BTC" | "ETH", minLeftSec: number, nowMs: number): Promise<EcArenaMarket | null> {
  // Bind the sweep to a generous-but-bounded timeout so a slow/hung indexer
  // degrades gracefully inside the Vercel serverless budget instead of letting
  // the SDK's 30s GraphQL timeout blow the function's own limit.
  let timer: NodeJS.Timeout | undefined;
  const withBudget = <T,>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`arena sweep timed out after ${ARENA_SWEEP_TIMEOUT_MS}ms`)), ARENA_SWEEP_TIMEOUT_MS);
      p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });

  const fresh = await withBudget(discoverArenaFloor(asset, minLeftSec, Math.floor(nowMs / 1000)))
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

async function discoverArenaFloor(asset: "BTC" | "ETH", minLeftSec: number, now: number): Promise<EcArenaMarket | null> {
  const prefix = asset === "BTC" ? "BTC-" : "ETH-";
  const exchange = ecExchange();

  let markets: UnifiedMarket[] = Object.values(exchange.markets ?? {});
  if (markets.length === 0) {
    markets = Object.values(await exchange.loadMarkets(true));
  }

  const floors: EcArenaMarket[] = [];
  for (const m of markets) {
    if (m.type !== "binary") continue;
    if (!m.symbol.startsWith(prefix)) continue;
    if (m.symbol.includes("-0-")) continue; // zero-strike placeholder: never settles
    const info = m.info as BinaryMarket & { expiry?: string | number };
    // Cheap indexer-side pre-filter: only near-future windows. This bounds the
    // expensive per-market on-chain probe to the handful of windows potentially
    // live (the venue keeps rolling fresh ones), instead of RPC-probing all
    // historical windows on every call (that blew past serverless timeouts).
    if (!info.expiry || Number(info.expiry) <= now + minLeftSec) continue;
    const onchain = await exchange.client
      .getMarketOnchain(m.id as `0x${string}`)
      .catch(() => null);
    if (!onchain) continue;
    if (onchain.status !== 1 || onchain.isResolved) continue; // only live + unsettled
    if (!onchain.expiry || Number(onchain.expiry) <= now) continue;
    const leftSec = Number(onchain.expiry) - now;
    if (leftSec < minLeftSec) continue;
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
  // Pick the soonest-settling window so the position resolves shortly after
  // opening (not at a far-future expiry).
  floors.sort((a, b) => a.expiry - b.expiry);
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
 */
export async function readArenaPrice(arena: EcArenaMarket): Promise<EcPriceQuote> {
  const exchange = ecExchange();
  try {
    const book = await exchange.fetchOrderBook(arena.symbol, 1);
    const bestBid = book.bids[0]?.[0] ?? null;
    const bestAsk = book.asks[0]?.[0] ?? null;
    const yesPrice =
      bestBid !== null && bestAsk !== null
        ? (bestBid + bestAsk) / 2
        : bestBid ?? bestAsk;
    return {
      yesPrice: yesPrice === null ? null : yesPrice,
      bestBid: bestBid === null ? null : bestBid,
      bestAsk: bestAsk === null ? null : bestAsk,
      updatedMs: Date.now(),
    };
  } catch {
    return { yesPrice: null, bestBid: null, bestAsk: null, updatedMs: Date.now() };
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
