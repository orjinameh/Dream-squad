import { connectToDatabase } from "@/db/connect";
import { randomUUID } from "node:crypto";
import { Match, ROUND_TIMINGS } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { generateMatchPriceModel } from "@/lib/prices";
import { z } from "zod";
import { isAddress } from "viem";

const createMatchSchema = z.object({
  playerAddress: z.string().refine((v) => isAddress(v), "invalid address"),
  playerChar: z.string().min(1),
  rivalName: z.string().min(1),
  rivalChar: z.string().min(1),
  mode: z.string().min(1),
  totalRounds: z.number().int().positive(),
  botDifficulty: z.enum(["easy", "normal", "hard"]).optional(),
  predictionAsset: z.string().optional(),
});

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError(400, "body must be JSON"); }

  const parsed = createMatchSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, `validation failed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const input = parsed.data;

  try {
    await connectToDatabase();
    const address = normalizeAddress(input.playerAddress);

    // ENFORCE ONE ACTIVE MATCH PER WALLET
    const activeMatch = await Match.findOne({
      $or: [{ playerAddress: address }, { player2Address: address }],
      status: "ACTIVE",
    }).lean();

    if (activeMatch) {
      return jsonError(409, "already in an active match");
    }

    const now = new Date();
    const deadline = new Date(now.getTime() + ROUND_TIMINGS.ROUND_DURATION_MS + ROUND_TIMINGS.LOCK_MS); // lock window before round 1

    const asset = input.predictionAsset ?? "BTC";
    const matchId = randomUUID();
    // ONE continuous market for the whole match (seeded by matchId) — carved
    // into round checkpoints so the chart, combat, and P&L all agree.
    const priceModel = generateMatchPriceModel(matchId, asset, input.totalRounds);

    const match = await Match.create({
      _id: matchId,
      playerAddress: address,
      playerChar: input.playerChar,
      rivalName: input.rivalName,
      rivalChar: input.rivalChar,
      mode: input.mode,
      totalRounds: input.totalRounds,
      currentRound: 1,
      roundPhase: "ACTIVE",
      roundStartTime: now,
      roundDeadline: deadline,
      status: "ACTIVE",
      botDifficulty: input.botDifficulty ?? "normal",
      predictionAsset: asset,
      predictionQuestion: `WILL ${asset} GO UP OR DOWN?`,
      priceModel,
    });

    return Response.json({
      matchId: match._id,
      serverTime: now.toISOString(),
      roundStartTime: now.toISOString(),
      roundDeadline: deadline.toISOString(),
    }, { status: 201 });
  } catch (err) {
    console.error("create match failed", err);
    return jsonError(500, "failed to create match");
  }
}
