import { connectToDatabase } from "@/db/connect";
import { PlayerStats } from "@/db/models/PlayerStats";
import { Match } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { getRankLabel, getRankFromPoints } from "@/lib/rank";
import { isAddress } from "viem";
import { CHARACTERS } from "@/game/characters";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");

  if (!address || !isAddress(address)) {
    return jsonError(400, "valid address required");
  }

  try {
    await connectToDatabase();
    const addr = normalizeAddress(address);

    // Atomic read-or-create: concurrent GETs must not both create → duplicate-key 500.
    const stats = await PlayerStats.findOneAndUpdate(
      { _id: addr },
      { $setOnInsert: { address: addr, favoriteChar: "dreamer", lastPlayedAt: new Date(), rankPoints: 500 } },
      { upsert: true, new: true },
    ).lean();

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
  if (!address || !isAddress(address)) return jsonError(400, "valid address required");
  if (!favoriteChar) return jsonError(400, "favoriteChar required");
  const validChars = new Set(CHARACTERS.map((c) => c.id));
  if (typeof favoriteChar !== "string" || favoriteChar.length > 32 || !validChars.has(favoriteChar)) {
    return jsonError(400, "invalid favoriteChar");
  }

  try {
    await connectToDatabase();
    const addr = normalizeAddress(address);

    // No upsert-with-partial-defaults: creating a doc with only favoriteChar
    // pollutes the leaderboard with junk 0-stat rows. Require existing profile.
    const updated = await PlayerStats.findOneAndUpdate(
      { _id: addr },
      { $set: { favoriteChar } },
      { new: true },
    );
    if (!updated) return jsonError(404, "profile not found");

    return Response.json({ ok: true, favoriteChar });
  } catch (err) {
    console.error("update profile failed", err);
    return jsonError(500, "failed to update profile");
  }
}
