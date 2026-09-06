import { connectToDatabase } from "@/db/connect";
import { PlayerStats } from "@/db/models/PlayerStats";
import { jsonError } from "@/lib/utils";
import { getRankLabel } from "@/lib/rank";
import { isAddress } from "viem";

export const dynamic = "force-dynamic";

type SortField = "rank" | "wins" | "accuracy" | "streak";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1), 100);
  const address = url.searchParams.get("address");
  const rawSort = url.searchParams.get("sort") ?? "rank";
  const allowedSorts = ["rank", "wins", "accuracy", "streak"] as const;
  if (!allowedSorts.includes(rawSort as SortField)) return jsonError(400, "invalid sort (rank|wins|accuracy|streak)");
  const sort = rawSort as SortField;
  if (address && !isAddress(address)) return jsonError(400, "invalid address");

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
