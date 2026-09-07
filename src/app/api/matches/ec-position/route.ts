import { connectToDatabase } from "@/db/connect";
import { Match } from "@/db/models/Match";
import { readArenaPrice } from "@/lib/ec/executor";
import { ecArenaForMatch } from "@/lib/ec/arena";
import { EC_ORACLE_EPSILON } from "@/lib/ec/config";
import { jsonError } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * GET /api/matches/ec-position?matchId=...
 *
 * Live Event-Contract position for a match. Reads the REAL current YES price of
 * the arena the match runs inside and compares it against the window-open YES
 * anchor the match is pinned to. Nothing here is simulated — the price is the
 * live EC order-book mid, the anchor is the pinned window-open seed the match
 * resolves rounds against. Lets the player see where their position stands
 * before the ~15 min window settles on-chain.
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const matchId = searchParams.get("matchId");
    if (!matchId || matchId.length > 64) return jsonError(400, "valid matchId required");

    await connectToDatabase();
    let match: any;
    try {
      match = await Match.findById(matchId).lean();
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === "CastError") return jsonError(400, "invalid matchId");
      throw err;
    }
    if (!match) return jsonError(404, "match not found");

    const asset = (match.priceModel?.asset ?? match.predictionAsset ?? "BTC") as "BTC" | "ETH";

    const arena = await ecArenaForMatch(match, asset, { preferBook: true });
    if (!arena) {
      return Response.json({
        asset,
        marketId: null,
        live: false,
        reason: "lockout",
        remainingSec: 0,
        yesPrice: null,
        arenaOpen: (match.priceModel as any)?.arenaOpen ?? null,
      });
    }

    const quote = await readArenaPrice(arena);
    const arenaOpenRaw = (match.priceModel as any)?.arenaOpen;
    // Don't mask a missing anchor with the live price (that forces direction
    // FLAT and misleads the UI). Surface null so the client shows "waiting".
    const arenaOpen = arenaOpenRaw && arenaOpenRaw > 0 ? arenaOpenRaw : null;

    const now = Math.floor(Date.now() / 1000);
    const remainingSec = Math.max(0, arena.expiry - now);
    const yesPrice = quote.yesPrice && quote.yesPrice > 0 ? quote.yesPrice : null;

    let direction: "UP" | "DOWN" | "FLAT" | null = null;
    if (yesPrice !== null && arenaOpen !== null) {
      // Same epsilon judge as round resolution: any real tick move counts.
      const diff = yesPrice - arenaOpen;
      const band = EC_ORACLE_EPSILON;
      direction = diff > band ? "UP" : diff < -band ? "DOWN" : "FLAT";
    }

    return Response.json({
      asset,
      marketId: arena.marketId,
      symbol: arena.symbol,
      live: true,
      remainingSec,
      expirySec: arena.expiry,
      yesPrice,
      bestBid: quote.bestBid,
      bestAsk: quote.bestAsk,
      arenaOpen,
      direction,
      updatedMs: quote.updatedMs,
    });
  } catch (err) {
    console.error("[ec-position] failed", err);
    return jsonError(500, "ec-position unavailable");
  }
}
