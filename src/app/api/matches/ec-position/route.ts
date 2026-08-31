import { NextResponse } from "next/server";
import { connectToDatabase } from "@/db/connect";
import { Match } from "@/db/models/Match";
import { readArenaPrice } from "@/lib/ec/executor";
import { ecArenaForMatch } from "@/lib/ec/arena";

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
    if (!matchId) return NextResponse.json({ error: "matchId required" }, { status: 400 });

    await connectToDatabase();
    const match = await Match.findById(matchId).lean();
    if (!match) return NextResponse.json({ error: "match not found" }, { status: 404 });

    const asset = (match.priceModel?.asset ?? match.predictionAsset ?? "BTC") as "BTC" | "ETH";

    const arena = await ecArenaForMatch(match, asset);
    if (!arena) {
      return NextResponse.json({
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
    const arenaOpen = arenaOpenRaw && arenaOpenRaw > 0
      ? arenaOpenRaw
      : (quote.yesPrice && quote.yesPrice > 0 ? quote.yesPrice : null);

    const now = Math.floor(Date.now() / 1000);
    const remainingSec = Math.max(0, arena.expiry - now);
    const yesPrice = quote.yesPrice && quote.yesPrice > 0 ? quote.yesPrice : null;

    let direction: "UP" | "DOWN" | "FLAT" | null = null;
    if (yesPrice !== null && arenaOpen !== null) {
      const diff = yesPrice - arenaOpen;
      const band = 0.0008;
      direction = diff > band ? "UP" : diff < -band ? "DOWN" : "FLAT";
    }

    return NextResponse.json({
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
    return NextResponse.json({ error: "ec-position unavailable" }, { status: 500 });
  }
}
