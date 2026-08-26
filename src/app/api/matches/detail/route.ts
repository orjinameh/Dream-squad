import { connectToDatabase } from "@/db/connect";
import { Match } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const matchId = url.searchParams.get("matchId");
  const address = url.searchParams.get("address");

  if (!matchId) return jsonError(400, "matchId required");

  try {
    await connectToDatabase();

    const match = await Match.findById(matchId).lean();
    if (!match) return jsonError(404, "match not found");

    // Verify the requester is a player in this match (if address provided)
    if (address) {
      const addr = normalizeAddress(address);
      const isPlayer1 = normalizeAddress(match.playerAddress) === addr;
      const isPlayer2 = match.player2Address && normalizeAddress(match.player2Address) === addr;
      if (!isPlayer1 && !isPlayer2) return jsonError(403, "not a player in this match");
    }

    const isBot = match.opponentType === "bot";

    // Compute prediction stats per player
    const rounds = match.rounds ?? [];
    const playerCorrectCount = rounds.filter((r) => r.playerCorrect).length;
    const rivalCorrectCount = rounds.filter((r) => r.rivalCorrect).length;

    // Count knockouts
    let knockouts = 0;
    let bestStreak = 0;
    let currentStreak = 0;
    for (const r of rounds) {
      if (r.playerCorrect) {
        currentStreak++;
        if (currentStreak > bestStreak) bestStreak = currentStreak;
      } else {
        currentStreak = 0;
      }
    }

    return Response.json({
      matchId: match._id,
      mode: match.mode,
      totalRounds: match.totalRounds,
      playerChar: match.playerChar,
      rivalName: isBot ? match.rivalName : (match.player2Address ? `${match.player2Address.slice(0, 6)}...${match.player2Address.slice(-4)}` : match.rivalName),
      rivalChar: match.rivalChar,
      playerScore: match.playerScore,
      rivalScore: match.rivalScore,
      winner: match.winner,
      opponentType: match.opponentType,
      botDifficulty: match.botDifficulty,
      completedAt: match.completedAt?.toISOString(),
      createdAt: match.createdAt?.toISOString(),
      // Prediction accuracy
      playerCorrectCount,
      rivalCorrectCount,
      totalRoundsPlayed: rounds.length,
      // Combat
      playerHP: match.playerHP,
      rivalHP: match.rivalHP,
      knockouts,
      bestStreak,
      // Rounds detail
      rounds: rounds.map((r) => ({
        roundNum: r.roundNum,
        playerPrediction: r.playerPrediction,
        rivalPrediction: r.rivalPrediction,
        actual: r.actual,
        playerCorrect: r.playerCorrect,
        rivalCorrect: r.rivalCorrect,
        playerExecution: r.playerExecution ? {
          status: r.playerExecution.status,
          txHash: r.playerExecution.txHash,
          direction: r.playerExecution.direction,
        } : null,
        rivalExecution: r.rivalExecution ? {
          status: r.rivalExecution.status,
          txHash: r.rivalExecution.txHash,
          direction: r.rivalExecution.direction,
        } : null,
      })),
    });
  } catch (err) {
    console.error("match detail failed", err);
    return jsonError(500, "failed to fetch match detail");
  }
}
