import { connectToDatabase } from "@/db/connect";
import { Match, ROUND_TIMINGS } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";
import { z } from "zod";
import { isAddress } from "viem";

const createMatchSchema = z.object({
  playerAddress: z.string().refine((v) => isAddress(v), "invalid address"),
  playerChar: z.string().min(1),
  rivalName: z.string().min(1),
  rivalChar: z.string().min(1),
  mode: z.string().min(1),
  totalRounds: z.number().int().positive(),
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
    const deadline = new Date(now.getTime() + 3_000); // 3s intro before first round

    const match = await Match.create({
      playerAddress: address,
      playerChar: input.playerChar,
      rivalName: input.rivalName,
      rivalChar: input.rivalChar,
      mode: input.mode,
      totalRounds: input.totalRounds,
      currentRound: 1,
      roundPhase: "WAITING",
      roundStartTime: now,
      roundDeadline: deadline,
      status: "ACTIVE",
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
