import { connectToDatabase } from "@/db/connect";
import { Match, type RoundRecord } from "@/db/models/Match";
import { PlayerStats } from "@/db/models/PlayerStats";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";
import { getPvpWinPoints } from "@/lib/rank";
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

    // Verify caller is a participant
    const isP1 = normalizeAddress(match.playerAddress) === address;
    const isP2 = match.player2Address && normalizeAddress(match.player2Address) === address;
    if (!isP1 && !isP2) return jsonError(403, "not a participant");

    // IDEMPOTENCY: if already completed, return existing result without double-counting
    if (match.status === "COMPLETED") {
      if (match.statsProcessed) {
        return Response.json({ matchId: input.matchId, winner: match.winner, idempotent: true });
      }
      // Match was completed but stats weren't processed — fall through to update stats
    }

    const winner = input.playerScore > input.rivalScore ? "player"
      : input.rivalScore > input.playerScore ? "rival" : "draw";

    // Mark match as completed atomically
    const completed = await Match.findOneAndUpdate(
      { _id: input.matchId, status: "ACTIVE" },
      {
        $set: {
          rounds: input.rounds as RoundRecord[],
          playerScore: input.playerScore,
          rivalScore: input.rivalScore,
          winner,
          status: "COMPLETED",
          completedAt: new Date(),
          statsProcessed: true,
        },
      },
      { new: true },
    );

    if (!completed) {
      // Already settled by another request
      return Response.json({ matchId: input.matchId, winner, idempotent: true });
    }

    const correctCount = input.rounds.filter((r) => r.playerCorrect).length;
    const longestStreak = computeLongestStreak(input.rounds);
    const isDraw = winner === "draw";
    const p1Win = winner === "player";
    const p2Win = winner === "rival";
    const p1RankDelta = getPvpWinPoints(p1Win, isDraw);
    const p2RankDelta = getPvpWinPoints(p2Win, isDraw);

    // Player 1 stats
    await PlayerStats.findOneAndUpdate(
      { _id: address },
      {
        $setOnInsert: { address },
        $inc: {
          totalWins: p1Win ? 1 : 0,
          totalLosses: !p1Win && !isDraw ? 1 : 0,
          totalDraws: isDraw ? 1 : 0,
          totalMatches: 1,
          totalRounds: input.rounds.length,
          correctPredictions: correctCount,
          pvpWins: p1Win ? 1 : 0,
          pvpLosses: !p1Win && !isDraw ? 1 : 0,
          pvpDraws: isDraw ? 1 : 0,
          pvpMatches: 1,
          pvpRounds: input.rounds.length,
          pvpCorrectPredictions: correctCount,
          rankPoints: p1RankDelta,
        },
        $max: { longestStreak },
        $addToSet: { processedMatches: input.matchId },
        $set: { lastPlayedAt: new Date(), favoriteChar: match.playerChar },
      },
      { upsert: true },
    );

    // Player 2 stats (PvP only)
    if (match.opponentType === "player" && match.player2Address) {
      const p2CorrectCount = input.rounds.filter((r) => r.rivalCorrect).length;
      const p2Rounds = input.rounds.map((r) => ({ playerCorrect: r.rivalCorrect }));
      const p2LongestStreak = computeLongestStreak(p2Rounds);
      const p2Address = normalizeAddress(match.player2Address);

      await PlayerStats.findOneAndUpdate(
        { _id: p2Address },
        {
          $setOnInsert: { address: p2Address },
          $inc: {
            totalWins: p2Win ? 1 : 0,
            totalLosses: !p2Win && !isDraw ? 1 : 0,
            totalDraws: isDraw ? 1 : 0,
            totalMatches: 1,
            totalRounds: input.rounds.length,
            correctPredictions: p2CorrectCount,
            pvpWins: p2Win ? 1 : 0,
            pvpLosses: !p2Win && !isDraw ? 1 : 0,
            pvpDraws: isDraw ? 1 : 0,
            pvpMatches: 1,
            pvpRounds: input.rounds.length,
            pvpCorrectPredictions: p2CorrectCount,
            rankPoints: p2RankDelta,
          },
          $max: { longestStreak: p2LongestStreak },
          $addToSet: { processedMatches: input.matchId },
          $set: { lastPlayedAt: new Date(), favoriteChar: match.player2Char || "dreamer" },
        },
        { upsert: true },
      );
    }

    return Response.json({ matchId: input.matchId, winner }, { status: 200 });
  } catch (err) {
    console.error("submit result failed", err);
    return jsonError(500, "failed to submit result");
  }
}
