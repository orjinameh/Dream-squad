import { connectToDatabase } from "@/db/connect";
import { Match } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";
import { isAddress } from "viem";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const matchId = url.searchParams.get("matchId");

  if (!matchId) return jsonError(400, "matchId required");

  try {
    await connectToDatabase();
    const match = await Match.findById(matchId);
    if (!match) return jsonError(404, "match not found");

    const now = new Date();
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
      playerScore: match.playerScore,
      rivalScore: match.rivalScore,
      playerPrediction: match.playerPrediction ?? null,
      rivalPrediction: match.rivalPrediction ?? null,
      rounds: match.rounds ?? [],
      winner: match.winner ?? "player",
      playerChar: match.playerChar,
      rivalChar: match.rivalChar,
      rivalName: match.rivalName,
    });
  } catch (err) {
    console.error("state failed", err);
    return jsonError(500, "failed to fetch state");
  }
}
