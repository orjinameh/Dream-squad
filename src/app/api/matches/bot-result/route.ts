import { connectToDatabase } from "@/db/connect";
import { PlayerStats } from "@/db/models/PlayerStats";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";
import { z } from "zod";
import { isAddress } from "viem";

const botResultSchema = z.object({
  idempotencyKey: z.string().min(1),
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
  winner: z.enum(["player", "rival", "draw"]),
  playerChar: z.string().min(1),
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

  const parsed = botResultSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, `validation failed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const input = parsed.data;

  try {
    await connectToDatabase();
    const address = normalizeAddress(input.playerAddress);

    const correctCount = input.rounds.filter((r) => r.playerCorrect).length;
    const longestStreak = computeLongestStreak(input.rounds);

    await PlayerStats.findOneAndUpdate(
      { _id: address },
      {
        $setOnInsert: { address },
        $inc: {
          totalWins: input.winner === "player" ? 1 : 0,
          totalLosses: input.winner === "rival" ? 1 : 0,
          totalDraws: input.winner === "draw" ? 1 : 0,
          totalMatches: 1,
          totalRounds: input.rounds.length,
          correctPredictions: correctCount,
        },
        $max: { longestStreak },
        $set: { lastPlayedAt: new Date(), favoriteChar: input.playerChar },
      },
      { upsert: true },
    );

    return Response.json({ ok: true, winner: input.winner });
  } catch (err) {
    console.error("bot result failed", err);
    return jsonError(500, "failed to submit bot result");
  }
}
