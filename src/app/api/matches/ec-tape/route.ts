import { connectToDatabase } from "@/db/connect";
import { Match } from "@/db/models/Match";
import { readArenaPrice, findArenaFloor, type ArenaRef } from "@/lib/ec/executor";
import { ecArenaForMatch } from "@/lib/ec/arena";
import { EC_INDEXER_URL, EC_ORACLE_EPSILON } from "@/lib/ec/config";
import { jsonError } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TAPE_LIMIT = 120;
const PROB_MIN = 0.01;
const PROB_MAX = 0.99;
const SCALE = 1_000_000;

const clampProb = (p: number): number => Math.min(PROB_MAX, Math.max(PROB_MIN, p));

interface TapePoint {
  t: number; // unix seconds
  p: number; // YES probability, clamped to [0.01, 0.99]
  v: number; // tUSDC value traded at this tick (0 for the live edge poll)
}

/**
 * Recent fills for a pool scoped to ONE market window (a binary pool is
 * recycled across successive markets — never mix windows). Newest-first from
 * the indexer, mapped to ascending probability points.
 */
async function windowTape(pool: string, marketId: string): Promise<TapePoint[]> {
  const query = `
    query Tape {
      Fill(
        where: { pool: { _eq: "${pool.toLowerCase()}" }, market_id: { _eq: "${marketId.toLowerCase()}" } },
        order_by: [{ timestamp: desc }, { blockNumber: desc }],
        limit: ${TAPE_LIMIT}
      ) { fillPrice timestamp quoteQuantity }
    }`;
  const res = await fetch(EC_INDEXER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(6_000),
  });
  const json = (await res.json()) as { data?: { Fill?: { fillPrice?: string | number; timestamp?: string | number; quoteQuantity?: string | number }[] } };
  const rows = json.data?.Fill ?? [];
  const pts: TapePoint[] = [];
  for (const r of rows) {
    const t = Number(r.timestamp);
    const p = Number(r.fillPrice) / SCALE;
    if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(p) || p <= 0) continue;
    const rawV = Number(r.quoteQuantity) / SCALE;
    pts.push({ t: Math.floor(t), p: clampProb(p), v: Number.isFinite(rawV) && rawV > 0 ? rawV : 0 });
  }
  pts.sort((a, b) => a.t - b.t);
  // Collapse same-second duplicates (keep the latest tick; sum volume).
  const deduped: TapePoint[] = [];
  for (const pt of pts) {
    const last = deduped[deduped.length - 1];
    if (last && last.t === pt.t) { last.p = pt.p; last.v += pt.v; }
    else deduped.push(pt);
  }
  return deduped;
}

/**
 * GET /api/matches/ec-tape?matchId=… | ?asset=BTC|ETH
 *
 * The exact live YES-probability tape ($0.01–$0.99) ticking on the dreamDEX
 * Central Limit Order Book for the arena a match runs in — the same venue
 * series every round is judged against. Real fills only, scoped to the pinned
 * window; the current top-of-book mid rides as the live edge.
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const matchId = searchParams.get("matchId");
    const assetParam = searchParams.get("asset");
    if ((!matchId && !assetParam) || (matchId && matchId.length > 64)) {
      return jsonError(400, "matchId or asset=BTC|ETH required");
    }

    let arena: ArenaRef | null = null;
    let asset: "BTC" | "ETH" = "BTC";
    let entry: number | null = null;
    let match: any = null;

    if (matchId) {
      await connectToDatabase();
      try {
        match = await Match.findById(matchId).lean();
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === "CastError") return jsonError(400, "invalid matchId");
        throw err;
      }
      if (!match) return jsonError(404, "match not found");
      asset = ((match.priceModel?.asset ?? match.predictionAsset ?? "BTC") as string).toUpperCase() === "ETH" ? "ETH" : "BTC";
      arena = await ecArenaForMatch(match, asset);
      // Entry anchor: this round's Second-5 lock, else the match-level anchor.
      const cp = match.priceModel?.checkpoints?.[(match.currentRound ?? 1) - 1];
      const rawEntry = cp?.entryPrice ?? (match.priceModel as any)?.arenaOpen ?? null;
      entry = typeof rawEntry === "number" && rawEntry > 0 ? rawEntry : null;
    } else {
      const a = assetParam!.toUpperCase();
      if (a !== "BTC" && a !== "ETH") return jsonError(400, "asset must be BTC or ETH");
      asset = a;
      arena = await findArenaFloor(asset, 0);
    }

    if (!arena) {
      return Response.json({ asset, marketId: null, symbol: null, live: false, reason: "no-arena", points: [], edge: null, entry });
    }

    const [tape, quote] = await Promise.all([
      windowTape(arena.pool, arena.marketId).catch(() => [] as TapePoint[]),
      readArenaPrice(arena).catch(() => null),
    ]);

    const mid = quote?.yesPrice && quote.yesPrice > 0 ? clampProb(quote.yesPrice) : null;
    // Live edge carries no volume — polls move price, never trade size.
    const edge = mid != null
      ? { t: Math.floor(Date.now() / 1000), p: mid, v: 0 }
      : tape.length
        ? { ...tape[tape.length - 1] }
        : null;

    let direction: "UP" | "DOWN" | "FLAT" | null = null;
    if (edge && entry != null) {
      const diff = edge.p - entry;
      direction = diff > EC_ORACLE_EPSILON ? "UP" : diff < -EC_ORACLE_EPSILON ? "DOWN" : "FLAT";
    }

    const now = Math.floor(Date.now() / 1000);
    return Response.json({
      asset,
      marketId: arena.marketId,
      symbol: arena.symbol,
      live: true,
      reason: tape.length === 0 ? "no-fills-yet" : undefined,
      remainingSec: Math.max(0, arena.expiry - now),
      expirySec: arena.expiry,
      points: tape,
      edge,
      entry,
      direction,
    });
  } catch (err) {
    console.error("[ec-tape] failed", err);
    return jsonError(500, "ec-tape unavailable");
  }
}
