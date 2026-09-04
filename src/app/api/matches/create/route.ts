import { connectToDatabase } from "@/db/connect";
import { randomUUID } from "node:crypto";
import { Match, ROUND_TIMINGS } from "@/db/models/Match";
import { EcPosition } from "@/db/models/EcPosition";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { z } from "zod";
import { isAddress } from "viem";

/**
 * Combat match creation (v2 architecture).
 *
 * A combat MATCH is stats/rank only: 70s = 7 x 10s rounds. It does NOT carry a
 * stake and does NOT open an escrow — the player must already have an ACTIVE EC
 * POSITION (the ~15-min financial stake they set up on the POSITION screen).
 * The match references that position; money settles only on the position.
 */
const createMatchSchema = z.object({
  playerAddress: z.string().refine((v) => isAddress(v), "invalid address"),
  playerChar: z.string().min(1),
  rivalName: z.string().min(1),
  rivalChar: z.string().min(1),
  mode: z.string().min(1),
  totalRounds: z.number().int().positive().default(7),
  opponentType: z.enum(["bot", "player"]).optional(),
  botDifficulty: z.enum(["easy", "normal", "hard"]).optional(),
  predictionAsset: z.string().optional(),
  // Optional explicit position; defaults to the wallet's active one.
  positionId: z.string().optional(),
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
    const address = normalizeAddress(input.playerAddress).toLowerCase();

    // The player must have an ACTIVE EC POSITION to fight. Matches never create
    // a stake — they ride the position. No open position => no fight.
    let position = input.positionId
      ? await EcPosition.findOne({ _id: input.positionId, address, status: "ACTIVE" }).lean()
      : await EcPosition.findOne({ address, status: "ACTIVE" }).sort({ createdAt: -1 }).lean();

    if (!position) {
      return jsonError(409, "no active EC position — stake one first on the POSITION screen");
    }
    // Per-round positions (no windowCloseAt) don't expire on a v4 window schedule.
    if (position.windowCloseAt && new Date(position.windowCloseAt) <= new Date()) {
      return jsonError(409, "your EC position window has ended — open a new position to fight");
    }

    // Enforce one active match per wallet: a player with a live match can't open
    // a second one until the first resolves. Match either address casing (EIP-55
    // checksummed or lowercased) — callers historically varied.
    const checksumAddr = normalizeAddress(input.playerAddress);
    const activeOwnerFilter = {
      $or: [
        { playerAddress: { $in: [address, checksumAddr] } },
        { player2Address: { $in: [address, checksumAddr] } },
      ],
    };

    // Prune STALE active matches first. A broken session (page refresh mid-
    // round, a match stuck before funding existed, an abandoned tab) leaves an
    // ACTIVE match that never resolves. Its current round's deadline lapses and
    // stays lapsed — a healthy match always rolls its deadline forward at each
    // resolved round. Abandon those so a player isn't permanently locked out of
    // matching by a zombie row. A match with a deadline still in the future is a
    // LIVE fight and is NOT touched.
    const staleCutoff = new Date(Date.now() - 20_000);
    await Match.updateMany(
      { ...activeOwnerFilter, status: "ACTIVE", roundDeadline: { $lt: staleCutoff } },
      { $set: { status: "ABANDONED", completedAt: new Date(), funded: true } },
    );

    const activeMatch = await Match.findOne({ ...activeOwnerFilter, status: "ACTIVE" }).lean();
    if (activeMatch) {
      return jsonError(409, "already in an active match — finish it first");
    }

    const now = new Date();
    const commitDeadline = new Date(now.getTime() + ROUND_TIMINGS.COMMIT_DURATION_MS);

    const asset = input.predictionAsset ?? position.market ?? "BTC";
    const matchId = randomUUID();
    const isBot = input.opponentType !== "player";

    const match = await Match.create({
      _id: matchId,
      playerAddress: address,
      playerChar: input.playerChar,
      rivalName: input.rivalName,
      rivalChar: input.rivalChar,
      mode: input.mode,
      totalRounds: input.totalRounds,
      currentRound: 1,
      roundPhase: "COMMIT",
      roundStartTime: now,
      roundDeadline: commitDeadline,
      status: "ACTIVE",
      opponentType: isBot ? "bot" : "player",
      botDifficulty: input.botDifficulty ?? "normal",
      predictionAsset: asset,
      predictionQuestion: `WILL ${asset} GO UP OR DOWN?`,
      marketId: "EC",
      // Reference the player's active EC position (money lives there, not here).
      positionId: position._id,
      positionWindowId: position.windowId,
      positionDirection: position.direction,
      positionAmount: position.amount,
    });

    // Bump the position's match counter (stats only).
    await EcPosition.updateOne({ _id: position._id }, { $inc: { matchCount: 1 } });

    return Response.json({
      matchId: match._id,
      serverTime: now.toISOString(),
      roundStartTime: now.toISOString(),
      roundDeadline: commitDeadline.toISOString(),
      positionId: position._id,
      positionDirection: position.direction,
    }, { status: 201 });
  } catch (err) {
    console.error("create match failed", err);
    return jsonError(500, "failed to create match");
  }
}
