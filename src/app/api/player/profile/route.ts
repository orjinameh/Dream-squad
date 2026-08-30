import { connectToDatabase } from "@/db/connect";
import { PlayerStats } from "@/db/models/PlayerStats";
import { Match } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { getRankLabel, getRankFromPoints } from "@/lib/rank";

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
        rankPoints: 500,
        processedMatches: [],
      });
      stats = await PlayerStats.findById(addr).lean();
    }

    if (!stats) {
      return jsonError(500, "failed to load player profile");
    }

    const pvpAccuracy = stats.pvpRounds > 0
      ? Math.round((stats.pvpCorrectPredictions / stats.pvpRounds) * 100)
      : 0;
    const botAccuracy = stats.botRounds > 0
      ? Math.round((stats.botCorrectPredictions / stats.botRounds) * 100)
      : 0;
    const overallAccuracy = stats.totalRounds > 0
      ? Math.round((stats.correctPredictions / stats.totalRounds) * 100)
      : 0;

    const rank = await PlayerStats.countDocuments({ rankPoints: { $gt: stats.rankPoints } }) + 1;
    const rankInfo = getRankFromPoints(stats.rankPoints);
    const rankLabel = getRankLabel(stats.rankPoints);

    // Check for active match
    const activeMatch = await Match.findOne({
      $or: [{ playerAddress: addr }, { player2Address: addr }],
      status: "ACTIVE",
    }).lean();

    return Response.json({
      address: stats.address,
      favoriteChar: stats.favoriteChar,
      lastPlayedAt: stats.lastPlayedAt,
      // Overall
      totalMatches: stats.totalMatches,
      totalWins: stats.totalWins,
      totalLosses: stats.totalLosses,
      totalDraws: stats.totalDraws,
      accuracy: overallAccuracy,
      longestStreak: stats.longestStreak,
      // PvP
      pvp: {
        matches: stats.pvpMatches,
        wins: stats.pvpWins,
        losses: stats.pvpLosses,
        draws: stats.pvpDraws,
        rounds: stats.pvpRounds,
        correctPredictions: stats.pvpCorrectPredictions,
        accuracy: pvpAccuracy,
      },
      // Bot
      bot: {
        matches: stats.botMatches,
        wins: stats.botWins,
        losses: stats.botLosses,
        draws: stats.botDraws,
        rounds: stats.botRounds,
        correctPredictions: stats.botCorrectPredictions,
        accuracy: botAccuracy,
      },
      // Combat
      knockouts: stats.knockouts,
      timesKnockedOut: stats.timesKnockedOut,
      // Rank
      rankPoints: stats.rankPoints,
      rank: rankInfo,
      rankLabel,
      leaderboardRank: rank,
      // Trading balance (USDso)
      balance: stats.balance ?? 100,
      // Active match
      activeMatchId: activeMatch?._id ?? null,
    });
  } catch (err) {
    console.error("player profile failed", err);
    return jsonError(500, "failed to load player profile");
  }
}

export async function PUT(req: Request): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError(400, "body must be JSON"); }

  const { address, favoriteChar } = body as { address?: string; favoriteChar?: string };
  if (!address || !address.startsWith("0x")) return jsonError(400, "address required");
  if (!favoriteChar) return jsonError(400, "favoriteChar required");

  try {
    await connectToDatabase();
    const addr = normalizeAddress(address);

    await PlayerStats.findOneAndUpdate(
      { _id: addr },
      { $set: { favoriteChar } },
      { upsert: true },
    );

    return Response.json({ ok: true, favoriteChar });
  } catch (err) {
    console.error("update profile failed", err);
    return jsonError(500, "failed to update profile");
  }
}
