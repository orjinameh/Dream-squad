import { connectToDatabase } from "@/db/connect";
import { Match } from "@/db/models/Match";
import { PlayerStats } from "@/db/models/PlayerStats";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";
import { z } from "zod";
import { isAddress } from "viem";

const botResultSchema = z.object({
  idempotencyKey: z.string().min(1),
  matchId: z.string().optional(),
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
  playerHP: z.number().optional(),
  rivalHP: z.number().optional(),
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

    // Idempotency: check if this key was already processed
    const existing = await PlayerStats.findOne({ _id: address, lastBotResultKey: input.idempotencyKey }).lean();
    if (existing) {
      return Response.json({ ok: true, winner: input.winner, deduped: true });
    }

    // Validate match exists and is active before processing
    if (input.matchId) {
      const match = await Match.findById(input.matchId);
      if (!match) return jsonError(404, "match not found");
      if (match.status !== "ACTIVE") {
        // Already settled — idempotent return
        return Response.json({ ok: true, winner: match.winner, deduped: true });
      }
      // Verify the caller is the match participant
      if (normalizeAddress(match.playerAddress) !== address) {
        return jsonError(403, "not a participant in this match");
      }
      // Mark match as completed atomically
      const completed = await Match.findOneAndUpdate(
        { _id: input.matchId, status: "ACTIVE" },
        {
          $set: {
            playerScore: input.playerScore,
            rivalScore: input.rivalScore,
            winner: input.winner,
            status: "COMPLETED",
            completedAt: new Date(),
            rounds: input.rounds,
            statsProcessed: true,
          },
        },
        { new: true },
      );
      if (!completed) {
        // Race condition: another request settled it first
        return Response.json({ ok: true, winner: input.winner, deduped: true });
      }
    }

    const correctCount = input.rounds.filter((r) => r.playerCorrect).length;
    const longestStreak = computeLongestStreak(input.rounds);
    const winPoints = input.winner === "player" ? 1 : 0;
    const lossPoints = input.winner === "rival" ? 1 : 0;
    const drawPoints = input.winner === "draw" ? 1 : 0;

    await PlayerStats.findOneAndUpdate(
      { _id: address },
      {
        $setOnInsert: { address },
        $inc: {
          totalWins: winPoints,
          totalLosses: lossPoints,
          totalDraws: drawPoints,
          totalMatches: 1,
          totalRounds: input.rounds.length,
          correctPredictions: correctCount,
          botWins: winPoints,
          botLosses: lossPoints,
          botDraws: drawPoints,
          botMatches: 1,
          botRounds: input.rounds.length,
          botCorrectPredictions: correctCount,
        },
        $max: { longestStreak },
        $set: { lastPlayedAt: new Date(), favoriteChar: input.playerChar, lastBotResultKey: input.idempotencyKey },
      },
      { upsert: true },
    );

    return Response.json({ ok: true, winner: input.winner });
  } catch (err) {
    console.error("bot result failed", err);
    return jsonError(500, "failed to submit bot result");
  }
}
