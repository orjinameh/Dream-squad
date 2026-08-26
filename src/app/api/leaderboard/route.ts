import { connectToDatabase } from "@/db/connect";
import { PlayerStats } from "@/db/models/PlayerStats";
import { jsonError } from "@/lib/utils";
import { getRankLabel } from "@/lib/rank";

export const dynamic = "force-dynamic";

type SortField = "rank" | "wins" | "accuracy" | "streak";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 100);
  const address = url.searchParams.get("address");
  const sort = (url.searchParams.get("sort") ?? "rank") as SortField;

  try {
    await connectToDatabase();

    // Single player lookup
    if (address) {
      const stats = await PlayerStats.findById(address).lean();
      if (!stats) return Response.json({ player: null });
      const totalPreds = stats.totalPredictions ?? stats.totalRounds;
      const accuracy = totalPreds > 0 ? Math.round((stats.correctPredictions / totalPreds) * 100) : 0;
      return Response.json({
        player: {
          address: stats.address,
          totalWins: stats.totalWins,
          totalLosses: stats.totalLosses,
          totalDraws: stats.totalDraws,
          totalMatches: stats.totalMatches,
          correctPredictions: stats.correctPredictions,
          totalPredictions: totalPreds,
          pvpWins: stats.pvpWins,
          pvpLosses: stats.pvpLosses,
          pvpMatches: stats.pvpMatches,
          accuracy,
          rankPoints: stats.rankPoints,
          rankLabel: getRankLabel(stats.rankPoints),
          longestStreak: stats.longestStreak,
          favoriteChar: stats.favoriteChar,
          lastPlayedAt: stats.lastPlayedAt,
        },
      });
    }

    // Sort config
    let sortConfig: Record<string, 1 | -1>;
    switch (sort) {
      case "wins":
        sortConfig = { pvpWins: -1, totalWins: -1 };
        break;
      case "accuracy":
        sortConfig = { correctPredictions: -1, totalPredictions: -1 };
        break;
      case "streak":
        sortConfig = { longestStreak: -1, pvpWins: -1 };
        break;
      case "rank":
      default:
        sortConfig = { rankPoints: -1, pvpWins: -1 };
        break;
    }

    const leaders = await PlayerStats.find({ $or: [{ pvpMatches: { $gt: 0 } }, { totalMatches: { $gt: 0 } }] })
      .sort(sortConfig)
      .limit(limit)
      .lean();

    return Response.json({
      leaderboard: leaders.map((p, i) => {
        const totalPreds = p.totalPredictions ?? p.totalRounds;
        const accuracy = totalPreds > 0 ? Math.round((p.correctPredictions / totalPreds) * 100) : 0;
        return {
          rank: i + 1,
          address: p.address,
          totalWins: p.totalWins,
          totalLosses: p.totalLosses,
          totalMatches: p.totalMatches,
          pvpWins: p.pvpWins,
          pvpLosses: p.pvpLosses,
          pvpMatches: p.pvpMatches,
          correctPredictions: p.correctPredictions,
          totalPredictions: totalPreds,
          longestStreak: p.longestStreak,
          favoriteChar: p.favoriteChar,
          accuracy,
          rankPoints: p.rankPoints,
          rankLabel: getRankLabel(p.rankPoints),
        };
      }),
    });
  } catch (err) {
    console.error("leaderboard failed", err);
    return jsonError(500, "failed to fetch leaderboard");
  }
}
