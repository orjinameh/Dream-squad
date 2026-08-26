import { connectToDatabase } from "@/db/connect";
import { Match } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const matchId = url.searchParams.get("matchId");
  const viewerAddress = url.searchParams.get("address");

  if (!matchId) return jsonError(400, "matchId required");

  try {
    await connectToDatabase();
    const match = await Match.findById(matchId);
    if (!match) return jsonError(404, "match not found");

    const now = new Date();
    const isPvP = match.opponentType === "player";
    const isViewerP2 = isPvP && viewerAddress && match.player2Address && normalizeAddress(viewerAddress) === normalizeAddress(match.player2Address);

    // Swap perspective if viewer is player2
    const myScore = isViewerP2 ? match.rivalScore : match.playerScore;
    const theirScore = isViewerP2 ? match.playerScore : match.rivalScore;
    const myPred = isViewerP2 ? match.rivalPrediction : match.playerPrediction;
    const theirPred = isViewerP2 ? match.playerPrediction : match.rivalPrediction;
    const myChar = isViewerP2 ? match.player2Char || match.rivalChar : match.playerChar;
    const theirChar = isViewerP2 ? match.playerChar : match.player2Char || match.rivalChar;
    const rounds = (match.rounds ?? []).map((r: any) => ({
      roundNum: r.roundNum,
      playerPrediction: isViewerP2 ? r.rivalPrediction : r.playerPrediction,
      rivalPrediction: isViewerP2 ? r.playerPrediction : r.rivalPrediction,
      actual: r.actual,
      playerCorrect: isViewerP2 ? r.rivalCorrect : r.playerCorrect,
      rivalCorrect: isViewerP2 ? r.playerCorrect : r.rivalCorrect,
    }));

    return Response.json({
      matchId: match._id,
      status: match.status,
      mode: match.mode,
      totalRounds: match.totalRounds,
      currentRound: match.currentRound,
      roundPhase: match.roundPhase,
      roundStartTime: match.roundStartTime.toISOString(),
      roundDeadline: match.roundDeadline.toISOString(),
      serverTime: now.toISOString(),
      playerScore: myScore,
      rivalScore: theirScore,
      playerPrediction: myPred ?? null,
      rivalPrediction: theirPred ?? null,
      rounds,
      winner: match.winner ?? "player",
      playerChar: myChar,
      rivalChar: theirChar,
      rivalName: match.rivalName,
      opponentType: match.opponentType ?? "bot",
      player2Char: match.player2Char,
      player1Ready: match.player1Ready ?? true,
      player2Ready: match.player2Ready ?? false,
      predictionAsset: match.predictionAsset ?? "BTC",
      predictionQuestion: match.predictionQuestion ?? "WILL BTC GO UP OR DOWN?",
      botDifficulty: match.botDifficulty ?? "normal",
    });
  } catch (err) {
    console.error("state failed", err);
    return jsonError(500, "failed to fetch state");
  }
}
