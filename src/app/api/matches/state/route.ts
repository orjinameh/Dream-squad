import { connectToDatabase } from "@/db/connect";
import { Match, type RoundPhase, type StatsProcessedStatus } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";
import { deriveRoundOutcome } from "@/lib/operator";

export const dynamic = "force-dynamic";

const MAX_HP = 100;

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
    const isViewerP2 = !!(isPvP && viewerAddress && match.player2Address && normalizeAddress(viewerAddress) === normalizeAddress(match.player2Address));

    // Auto-resolve expired bot rounds (server-authoritative)
    if (match.status === "ACTIVE" && match.opponentType === "bot" && match.roundPhase === "ACTIVE" && now.getTime() > match.roundDeadline.getTime()) {
      // Check if player predicted
      if (!match.playerPrediction) {
        // No prediction submitted — mark as draw/no-contest for this round
        const roundRecord = {
          roundNum: match.currentRound,
          playerPrediction: null,
          rivalPrediction: null,
          actual: "UP" as const,
          playerCorrect: false,
          rivalCorrect: false,
          roundWinner: "draw" as const,
          damage: 0,
          playerDamage: 0,
          rivalDamage: 0,
          isCritical: false,
          knockout: false,
          resolvedAt: now,
        };

        const isLastRound = match.currentRound >= match.totalRounds;
        const nextDeadline = new Date(now.getTime() + 1000);

        await Match.findByIdAndUpdate(matchId, {
          $push: { rounds: roundRecord },
          $set: {
            roundPhase: isLastRound ? "REVEALED" : "ACTIVE",
            status: isLastRound ? "COMPLETED" : "ACTIVE",
            ...(isLastRound ? { completedAt: now, winner: "draw", statsProcessed: "PENDING" as StatsProcessedStatus } : {
              currentRound: match.currentRound + 1,
              playerPrediction: null,
              rivalPrediction: null,
              roundStartTime: now,
              roundDeadline: nextDeadline,
            }),
          },
        });

        const updated = await Match.findById(matchId);
        if (updated) {
          return Response.json(buildState(updated, now, isViewerP2, viewerAddress));
        }
      }
      // If player predicted but predict endpoint hasn't resolved yet,
      // the predict endpoint will handle it. Return current state.
    }

    return Response.json(buildState(match, now, isViewerP2, viewerAddress));
  } catch (err) {
    console.error("state failed", err);
    return jsonError(500, "failed to fetch state");
  }
}

function buildState(match: any, serverTime: Date, isViewerP2: boolean, viewerAddress: string | null) {
  const rounds = (match.rounds ?? []).map((r: any) => ({
    roundNum: r.roundNum,
    playerPrediction: isViewerP2 ? r.rivalPrediction : r.playerPrediction,
    rivalPrediction: isViewerP2 ? r.playerPrediction : r.rivalPrediction,
    actual: r.actual,
    playerCorrect: isViewerP2 ? r.rivalCorrect : r.playerCorrect,
    rivalCorrect: isViewerP2 ? r.playerCorrect : r.rivalCorrect,
    // Server-authoritative combat data
    roundWinner: r.roundWinner,
    damage: r.damage,
    playerDamage: isViewerP2 ? r.rivalDamage : r.playerDamage,
    rivalDamage: isViewerP2 ? r.playerDamage : r.rivalDamage,
    isCritical: r.isCritical,
    knockout: r.knockout,
    playerExecution: r.playerExecution,
    rivalExecution: r.rivalExecution,
  }));

  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : undefined;

  // Perspective-safe fields
  const myScore = isViewerP2 ? match.rivalScore : match.playerScore;
  const theirScore = isViewerP2 ? match.playerScore : match.rivalScore;
  const myPred = isViewerP2 ? match.rivalPrediction : match.playerPrediction;
  const theirPred = isViewerP2 ? match.playerPrediction : match.rivalPrediction;
  const myChar = isViewerP2 ? match.player2Char || match.rivalChar : match.playerChar;
  const theirChar = isViewerP2 ? match.playerChar : match.player2Char || match.rivalChar;
  const myHP = isViewerP2 ? match.rivalHP : match.playerHP;
  const theirHP = isViewerP2 ? match.playerHP : match.rivalHP;
  const myStreak = isViewerP2 ? match.rivalStreak : match.playerStreak;
  const theirStreak = isViewerP2 ? match.playerStreak : match.rivalStreak;

  return {
    matchId: match._id,
    status: match.status,
    mode: match.mode,
    totalRounds: match.totalRounds,
    currentRound: match.currentRound,
    roundPhase: match.roundPhase,
    roundStartTime: match.roundStartTime?.toISOString?.() ?? match.roundStartTime,
    roundDeadline: match.roundDeadline?.toISOString?.() ?? match.roundDeadline,
    serverTime: serverTime.toISOString(),
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
    hasOpponent: !!match.player2Address,
    player2Char: match.player2Char,
    player1Ready: match.player1Ready ?? true,
    player2Ready: match.player2Ready ?? false,
    predictionAsset: match.predictionAsset ?? "BTC",
    predictionQuestion: match.predictionQuestion ?? "WILL BTC GO UP OR DOWN?",
    botDifficulty: match.botDifficulty ?? "normal",
    // Server-authoritative combat
    playerHP: myHP,
    rivalHP: theirHP,
    playerStreak: myStreak,
    rivalStreak: theirStreak,
    lastRound,
  };
}
