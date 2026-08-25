import { connectToDatabase } from "@/db/connect";
import { PlayerStats } from "@/db/models/PlayerStats";
import { jsonError } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 100);
  const address = url.searchParams.get("address");

  try {
    await connectToDatabase();

    if (address) {
      const stats = await PlayerStats.findById(address).lean();
      return Response.json({ player: stats ?? null });
    }

    const leaders = await PlayerStats.find()
      .sort({ totalWins: -1, correctPredictions: -1 })
      .limit(limit)
      .lean();

    return Response.json({
      leaderboard: leaders.map((p, i) => ({
        rank: i + 1,
        address: p.address,
        totalWins: p.totalWins,
        totalMatches: p.totalMatches,
        correctPredictions: p.correctPredictions,
        longestStreak: p.longestStreak,
        favoriteChar: p.favoriteChar,
        accuracy: p.totalRounds > 0 ? Math.round((p.correctPredictions / p.totalRounds) * 100) : 0,
      })),
    });
  } catch (err) {
    console.error("leaderboard failed", err);
    return jsonError(500, "failed to fetch leaderboard");
  }
}
