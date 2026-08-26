import { connectToDatabase } from "@/db/connect";
import { Match, ROUND_TIMINGS } from "@/db/models/Match";
import { PlayerStats } from "@/db/models/PlayerStats";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";
import { z } from "zod";
import { isAddress } from "viem";

const predictSchema = z.object({
  matchId: z.string().min(1),
  playerAddress: z.string().refine((v) => isAddress(v), "invalid address"),
  prediction: z.enum(["UP", "DOWN"]),
  clientTimestamp: z.string().optional(),
});

function randomOutcome(): "UP" | "DOWN" {
  return Math.random() < 0.5 ? "UP" : "DOWN";
}

function computeLongestStreak(rounds: Array<{ playerCorrect: boolean }>): number {
  let max = 0;
  let current = 0;
  for (const r of rounds) {
    if (r.playerCorrect) {
      current++;
      if (current > max) max = current;
    } else {
      current = 0;
    }
  }
  return max;
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError(400, "body must be JSON"); }

  const parsed = predictSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, `validation failed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const input = parsed.data;
  const now = new Date();

  try {
    await connectToDatabase();
    const address = normalizeAddress(input.playerAddress);

    const match = await Match.findById(input.matchId);
    if (!match) return jsonError(404, "match not found");
    if (match.status !== "ACTIVE") return jsonError(409, "match not active");

    const isPvP = match.opponentType === "player";

    // Validate player identity
    const isPlayer1 = normalizeAddress(match.playerAddress) === address;
    const isPlayer2 = isPvP && match.player2Address && normalizeAddress(match.player2Address) === address;

    if (!isPlayer1 && !isPlayer2) return jsonError(403, "not a player in this match");

    // DEADLINE VALIDATION: server clock is authoritative
    if (now.getTime() > match.roundDeadline.getTime() + 500) {
      return jsonError(409, "round deadline passed");
    }

    // Store prediction based on which player submitted
    const predField = isPlayer1 ? "playerPrediction" : "rivalPrediction";
    const existingPred = isPlayer1 ? match.playerPrediction : match.rivalPrediction;

    // Idempotency: if already predicted this round, return current state
    if (existingPred) {
      return Response.json(buildState(match, now));
    }

    // Set this player's prediction
    const updateField: Record<string, "UP" | "DOWN"> = {};
    updateField[predField] = input.prediction;
    await Match.findByIdAndUpdate(match._id, { $set: updateField });

    // Re-read to get both predictions
    const updated = await Match.findById(match._id);
    if (!updated) return jsonError(500, "match disappeared");

    // PvP: wait for both players to submit before resolving
    if (isPvP) {
      const bothPredicted = updated.playerPrediction && updated.rivalPrediction;

      if (!bothPredicted) {
        // Still waiting for opponent — return partial state
        return Response.json({
          ...buildState(updated, now),
          waitingForOpponent: true,
        });
      }

      // Both predicted — resolve the round
      return await resolvePvPRound(updated, now);
    }

    // Bot match: resolve immediately (AI prediction generated here)
    const difficulty = match.botDifficulty || "normal";
    const botCorrectBias = difficulty === "easy" ? 0.35 : difficulty === "hard" ? 0.65 : 0.5;
    const actual = randomOutcome();
    const botShouldBeCorrect = Math.random() < botCorrectBias;
    const rivalPred = botShouldBeCorrect ? actual : (actual === "UP" ? "DOWN" as const : "UP" as const);
    const playerCorrect = input.prediction === actual;
    const rivalCorrect = rivalPred === actual;

    return await finalizeRound(match, input.prediction, rivalPred, actual, playerCorrect, rivalCorrect, now);
  } catch (err) {
    console.error("predict failed", err);
    return jsonError(500, "failed to submit prediction");
  }
}

async function resolvePvPRound(match: any, now: Date): Promise<Response> {
  const actual = randomOutcome();
  const playerCorrect = match.playerPrediction === actual;
  const rivalCorrect = match.rivalPrediction === actual;

  return await finalizeRound(match, match.playerPrediction, match.rivalPrediction, actual, playerCorrect, rivalCorrect, now);
}

async function finalizeRound(
  match: any,
  playerPred: "UP" | "DOWN",
  rivalPred: "UP" | "DOWN",
  actual: "UP" | "DOWN",
  playerCorrect: boolean,
  rivalCorrect: boolean,
  now: Date,
): Promise<Response> {
  const roundRecord = {
    roundNum: match.currentRound,
    playerPrediction: playerPred,
    rivalPrediction: rivalPred,
    actual,
    playerCorrect,
    rivalCorrect,
  };

  const newPlayerScore = match.playerScore + (playerCorrect ? 1 : 0);
  const newRivalScore = match.rivalScore + (rivalCorrect ? 1 : 0);
  const isLastRound = match.currentRound >= match.totalRounds;
  const nextDeadline = new Date(now.getTime() + ROUND_TIMINGS.LOCK_MS + ROUND_TIMINGS.REVEAL_MS + ROUND_TIMINGS.IMPACT_MS + 500);

  if (isLastRound) {
    const winner = newPlayerScore > newRivalScore ? "player" : newRivalScore > newPlayerScore ? "rival" : "draw";
    const allRounds = [...(match.rounds as any[]), roundRecord];

    await Match.findByIdAndUpdate(match._id, {
      $push: { rounds: roundRecord },
      $set: {
        playerPrediction: playerPred,
        rivalPrediction: rivalPred,
        playerScore: newPlayerScore,
        rivalScore: newRivalScore,
        winner,
        status: "COMPLETED",
        roundPhase: "REVEALED",
        completedAt: now,
      },
    });

    await updatePlayerStats(match, allRounds, winner, now);
  } else {
    // Check early victory: can the trailing player still catch up?
    const remainingRounds = match.totalRounds - match.currentRound;
    const playerMaxPossible = newPlayerScore + remainingRounds;
    const rivalMaxPossible = newRivalScore + remainingRounds;
    const matchDecided = newPlayerScore > rivalMaxPossible || newRivalScore > playerMaxPossible;

    if (matchDecided) {
      const winner = newPlayerScore > newRivalScore ? "player" : newRivalScore > newPlayerScore ? "rival" : "draw";
      const allRounds = [...(match.rounds as any[]), roundRecord];

      await Match.findByIdAndUpdate(match._id, {
        $push: { rounds: roundRecord },
        $set: {
          playerPrediction: playerPred,
          rivalPrediction: rivalPred,
          playerScore: newPlayerScore,
          rivalScore: newRivalScore,
          winner,
          status: "COMPLETED",
          completedAt: now,
        },
      });

      // Update both players' stats
      await updatePlayerStats(match, allRounds, winner, now);
    } else {
      await Match.findByIdAndUpdate(match._id, {
        $push: { rounds: roundRecord },
        $set: {
          playerPrediction: playerPred,
          rivalPrediction: rivalPred,
          playerScore: newPlayerScore,
          rivalScore: newRivalScore,
          currentRound: match.currentRound + 1,
          roundPhase: "LOCKED",
          roundStartTime: now,
          roundDeadline: nextDeadline,
        },
      });
    }
  }

  const updated = await Match.findById(match._id);
  return Response.json(buildState(updated!, now));
}

export interface MatchStateResponse {
  matchId: string;
  status: string;
  mode: string;
  totalRounds: number;
  currentRound: number;
  roundPhase: string;
  roundStartTime: string;
  roundDeadline: string;
  serverTime: string;
  playerScore: number;
  rivalScore: number;
  playerPrediction: "UP" | "DOWN" | null;
  rivalPrediction: "UP" | "DOWN" | null;
  rounds: Array<{
    roundNum: number;
    playerPrediction: "UP" | "DOWN" | null;
    rivalPrediction: "UP" | "DOWN" | null;
    actual: "UP" | "DOWN";
    playerCorrect: boolean;
    rivalCorrect: boolean;
  }>;
  winner: string;
  opponentType?: string;
  player2Address?: string;
  player2Char?: string;
  player1Ready?: boolean;
  player2Ready?: boolean;
  predictionAsset?: string;
  predictionQuestion?: string;
  botDifficulty?: string;
}

async function updatePlayerStats(match: any, allRounds: any[], winner: string, now: Date) {
  // Player 1 stats
  const p1CorrectCount = allRounds.filter((r: any) => r.playerCorrect).length;
  const p1LongestStreak = computeLongestStreak(allRounds);
  await PlayerStats.findOneAndUpdate(
    { _id: normalizeAddress(match.playerAddress) },
    {
      $setOnInsert: { address: normalizeAddress(match.playerAddress) },
      $inc: {
        totalWins: winner === "player" ? 1 : 0,
        totalLosses: winner === "rival" ? 1 : 0,
        totalDraws: winner === "draw" ? 1 : 0,
        totalMatches: 1,
        totalRounds: allRounds.length,
        correctPredictions: p1CorrectCount,
      },
      $max: { longestStreak: p1LongestStreak },
      $set: { lastPlayedAt: now, favoriteChar: match.playerChar },
    },
    { upsert: true },
  );
  // Player 2 stats (PvP only)
  if (match.opponentType === "player" && match.player2Address) {
    const p2CorrectCount = allRounds.filter((r: any) => r.rivalCorrect).length;
    const p2Rounds = allRounds.map((r: any) => ({ playerCorrect: r.rivalCorrect }));
    const p2LongestStreak = computeLongestStreak(p2Rounds);
    await PlayerStats.findOneAndUpdate(
      { _id: normalizeAddress(match.player2Address) },
      {
        $setOnInsert: { address: normalizeAddress(match.player2Address) },
        $inc: {
          totalWins: winner === "rival" ? 1 : 0,
          totalLosses: winner === "player" ? 1 : 0,
          totalDraws: winner === "draw" ? 1 : 0,
          totalMatches: 1,
          totalRounds: allRounds.length,
          correctPredictions: p2CorrectCount,
        },
        $max: { longestStreak: p2LongestStreak },
        $set: { lastPlayedAt: now, favoriteChar: match.player2Char || "dreamer" },
      },
      { upsert: true },
    );
  }
}

function buildState(match: any, serverTime: Date): MatchStateResponse {
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
    playerScore: match.playerScore,
    rivalScore: match.rivalScore,
    playerPrediction: match.playerPrediction ?? null,
    rivalPrediction: match.rivalPrediction ?? null,
    rounds: match.rounds ?? [],
    winner: match.winner ?? "player",
    opponentType: match.opponentType,
    player2Address: match.player2Address,
    player2Char: match.player2Char,
    player1Ready: match.player1Ready,
    player2Ready: match.player2Ready,
    predictionAsset: match.predictionAsset,
    predictionQuestion: match.predictionQuestion,
    botDifficulty: match.botDifficulty,
  };
}
