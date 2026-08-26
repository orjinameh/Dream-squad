import { connectToDatabase } from "@/db/connect";
import { PlayerStats } from "@/db/models/PlayerStats";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");

  if (!address || !address.startsWith("0x")) {
    return jsonError(400, "address required");
  }

  try {
    await connectToDatabase();
    const addr = normalizeAddress(address);

    let stats = await PlayerStats.findById(addr).lean();

    if (!stats) {
      await PlayerStats.create({
        _id: addr,
        address: addr,
        totalWins: 0,
        totalLosses: 0,
        totalDraws: 0,
        totalMatches: 0,
        totalRounds: 0,
        correctPredictions: 0,
        longestStreak: 0,
        currentStreak: 0,
        favoriteChar: "dreamer",
        lastPlayedAt: new Date(),
      });
      stats = await PlayerStats.findById(addr).lean();
    }

    if (!stats) {
      return jsonError(500, "failed to load player profile");
    }

    const accuracy = stats.totalRounds > 0
      ? Math.round((stats.correctPredictions / stats.totalRounds) * 100)
      : 0;

    const rank = await PlayerStats.countDocuments({ totalWins: { $gt: stats.totalWins } }) + 1;

    return Response.json({
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
      rank,
      lastPlayedAt: stats.lastPlayedAt,
    });
  } catch (err) {
    console.error("player profile failed", err);
    return jsonError(500, "failed to load player profile");
  }
}
