import { connectToDatabase } from "@/db/connect";
import { Match, type RoundRecord } from "@/db/models/Match";
import { PlayerStats } from "@/db/models/PlayerStats";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";
import { z } from "zod";
import { isAddress } from "viem";

const resultSchema = z.object({
  matchId: z.string().min(1),
  playerAddress: z.string().refine((v) => isAddress(v), "invalid address"),
  rounds: z.array(z.object({
    roundNum: z.number(),
    playerPrediction: z.enum(["UP", "DOWN"]).nullable(),
    rivalPrediction: z.enum(["UP", "DOWN"]).nullable(),
    actual: z.enum(["UP", "DOWN"]),
    playerCorrect: z.boolean(),
    rivalCorrect: z.boolean(),
  })),
  playerScore: z.number().int().min(0),
  rivalScore: z.number().int().min(0),
});

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

  const parsed = resultSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, `validation failed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const input = parsed.data;

  try {
    await connectToDatabase();
    const address = normalizeAddress(input.playerAddress);

    const match = await Match.findById(input.matchId);
    if (!match) return jsonError(404, "match not found");

    // IDEMPOTENCY: if already completed, return existing result without double-counting
    if (match.status === "COMPLETED") {
      return Response.json({ matchId: input.matchId, winner: match.winner, idempotent: true });
    }

    const winner = input.playerScore > input.rivalScore ? "player"
      : input.rivalScore > input.playerScore ? "rival" : "draw";

    await Match.findByIdAndUpdate(input.matchId, {
      $set: {
        rounds: input.rounds as RoundRecord[],
        playerScore: input.playerScore,
        rivalScore: input.rivalScore,
        winner,
        status: "COMPLETED",
        completedAt: new Date(),
        statsProcessed: true,
      },
    });

    const correctCount = input.rounds.filter((r) => r.playerCorrect).length;
    const longestStreak = computeLongestStreak(input.rounds);

    await PlayerStats.findOneAndUpdate(
      { _id: address },
      {
        $setOnInsert: { address },
        $inc: {
          totalWins: winner === "player" ? 1 : 0,
          totalLosses: winner === "rival" ? 1 : 0,
          totalDraws: winner === "draw" ? 1 : 0,
          totalMatches: 1,
          totalRounds: input.rounds.length,
          correctPredictions: correctCount,
        },
        $max: { longestStreak },
        $set: { lastPlayedAt: new Date(), favoriteChar: match.playerChar },
      },
      { upsert: true },
    );

    return Response.json({ matchId: input.matchId, winner }, { status: 200 });
  } catch (err) {
    console.error("submit result failed", err);
    return jsonError(500, "failed to submit result");
  }
}
