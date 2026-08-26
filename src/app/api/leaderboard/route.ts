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
      if (!stats) return Response.json({ player: null });
      const accuracy = stats.totalRounds > 0 ? Math.round((stats.correctPredictions / stats.totalRounds) * 100) : 0;
      return Response.json({
        player: {
          address: stats.address,
          totalWins: stats.totalWins,
          totalLosses: stats.totalLosses,
          totalDraws: stats.totalDraws,
          totalMatches: stats.totalMatches,
          totalRounds: stats.totalRounds,
          correctPredictions: stats.correctPredictions,
          longestStreak: stats.longestStreak,
          currentStreak: stats.currentStreak,
          favoriteChar: stats.favoriteChar,
          accuracy,
          rankingScore: stats.totalWins * 100 + accuracy + stats.longestStreak * 10,
          lastPlayedAt: stats.lastPlayedAt,
        },
      });
    }

    const leaders = await PlayerStats.find()
      .sort({ totalWins: -1, correctPredictions: -1 })
      .limit(limit)
      .lean();

    return Response.json({
      leaderboard: leaders.map((p, i) => {
        const accuracy = p.totalRounds > 0 ? Math.round((p.correctPredictions / p.totalRounds) * 100) : 0;
        return {
          rank: i + 1,
          address: p.address,
          totalWins: p.totalWins,
          totalLosses: p.totalLosses,
          totalMatches: p.totalMatches,
          correctPredictions: p.correctPredictions,
          longestStreak: p.longestStreak,
          favoriteChar: p.favoriteChar,
          accuracy,
          rankingScore: p.totalWins * 100 + accuracy + p.longestStreak * 10,
        };
      }),
    });
  } catch (err) {
    console.error("leaderboard failed", err);
    return jsonError(500, "failed to fetch leaderboard");
  }
}
