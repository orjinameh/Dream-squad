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
    if (match.playerAddress !== address) return jsonError(403, "not your match");

    // DEADLINE VALIDATION: server clock is authoritative
    if (now.getTime() > match.roundDeadline.getTime() + 500) {
      return jsonError(409, "round deadline passed");
    }

    // IDEMPOTENCY: if already predicted this round, return current state
    if (match.playerPrediction && match.currentRound === match.currentRound) {
      return Response.json(buildState(match, now));
    }

    // AI rival prediction
    const rivalPred = Math.random() < 0.5 ? "UP" as const : "DOWN" as const;

    // Resolve round result
    const actual = randomOutcome();
    const playerCorrect = input.prediction === actual;
    const rivalCorrect = rivalPred === actual;

    const roundRecord = {
      roundNum: match.currentRound,
      playerPrediction: input.prediction,
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

      // Update match to COMPLETED
      await Match.findByIdAndUpdate(match._id, {
        $push: { rounds: roundRecord },
        $set: {
          playerPrediction: input.prediction,
          rivalPrediction: rivalPred,
          playerScore: newPlayerScore,
          rivalScore: newRivalScore,
          winner,
          status: "COMPLETED",
          roundPhase: "REVEALED",
          completedAt: now,
        },
      });

      // Update player stats in MongoDB (idempotent: only reached once because status check above blocks re-entry)
      const correctCount = allRounds.filter((r) => r.playerCorrect).length;
      const longestStreak = computeLongestStreak(allRounds);

      await PlayerStats.findOneAndUpdate(
        { _id: address },
        {
          $setOnInsert: { address },
          $inc: {
            totalWins: winner === "player" ? 1 : 0,
            totalLosses: winner === "rival" ? 1 : 0,
            totalDraws: winner === "draw" ? 1 : 0,
            totalMatches: 1,
            totalRounds: allRounds.length,
            correctPredictions: correctCount,
          },
          $max: { longestStreak },
          $set: { lastPlayedAt: now, favoriteChar: match.playerChar },
        },
        { upsert: true },
      );
    } else {
      await Match.findByIdAndUpdate(match._id, {
        $push: { rounds: roundRecord },
        $set: {
          playerPrediction: input.prediction,
          rivalPrediction: rivalPred,
          playerScore: newPlayerScore,
          rivalScore: newRivalScore,
          roundPhase: "LOCKED",
          roundStartTime: now,
          roundDeadline: nextDeadline,
        },
      });
    }

    // Read back updated state
    const updated = await Match.findById(match._id);
    return Response.json(buildState(updated!, now));
  } catch (err) {
    console.error("predict failed", err);
    return jsonError(500, "failed to submit prediction");
  }
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
}

function buildState(match: any, serverTime: Date): MatchStateResponse {
  return {
    matchId: match._id,
    status: match.status,
    mode: match.mode,
    totalRounds: match.totalRounds,
    currentRound: match.currentRound,
    roundPhase: match.roundPhase,
    roundStartTime: match.roundStartTime.toISOString(),
    roundDeadline: match.roundDeadline.toISOString(),
    serverTime: serverTime.toISOString(),
    playerScore: match.playerScore,
    rivalScore: match.rivalScore,
    playerPrediction: match.playerPrediction ?? null,
    rivalPrediction: match.rivalPrediction ?? null,
    rounds: match.rounds ?? [],
    winner: match.winner ?? "player",
  };
}
