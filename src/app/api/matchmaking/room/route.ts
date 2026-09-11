import { connectToDatabase } from "@/db/connect";
import { Match } from "@/db/models/Match";
import { MatchRoom, ROOM_TTL_MS, generateRoomCode, normalizeRoomCode } from "@/db/models/MatchRoom";
import { EcPosition } from "@/db/models/EcPosition";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { expireStaleWaitingMatches } from "@/lib/matchExpiry";
import { assertMatchFunding } from "@/lib/ec/funding";
import { randomUUID } from "node:crypto";
import { isAddress } from "viem";
import { CHARACTERS } from "@/game/characters";

export const dynamic = "force-dynamic";

/**
 * POST /api/matchmaking/room — create a private duel room.
 * Body: { address, rounds, charId?, amountPerRound? }
 * Returns a unique 6-char invite code (10-minute life). The host polls
 * GET ?address= until a guest claims it, then both proceed by matchId.
 */
export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const address = body.address as string | undefined;
  const rounds = body.rounds as number | undefined;
  const charId = body.charId as string | undefined;
  const amountPerRound = body.amountPerRound as number | undefined;

  if (!address || !isAddress(address)) {
    return jsonError(400, "valid wallet address required");
  }
  if (![3, 5, 7, 11].includes(rounds as number)) {
    return jsonError(400, "rounds must be 3, 5, 7, or 11");
  }
  if (amountPerRound !== undefined && (!(typeof amountPerRound === "number") || !(amountPerRound > 0) || amountPerRound > 100000)) {
    return jsonError(400, "amountPerRound must be a positive number");
  }
  const validCharIds = new Set(CHARACTERS.map((c) => c.id));
  if (charId && (typeof charId !== "string" || charId.length > 32 || !validCharIds.has(charId))) {
    return jsonError(400, "invalid charId");
  }

  try {
    await connectToDatabase();
    const addr = normalizeAddress(address);
    const lower = addr.toLowerCase();

    await expireStaleWaitingMatches(addr);
    const activeMatch = await Match.findOne({
      $or: [{ playerAddress: { $in: [addr, lower] } }, { player2Address: { $in: [addr, lower] } }],
      status: "ACTIVE",
    }).lean();
    if (activeMatch) {
      return Response.json({ status: "matched", matchId: activeMatch._id, message: "Already in an active match" });
    }

    const position = await EcPosition.findOne({ address: lower, status: "ACTIVE" }).sort({ createdAt: -1 }).lean();
    if (!position) {
      return jsonError(409, "no active EC position — stake one first on the POSITION screen");
    }
    if (position.windowCloseAt && new Date(position.windowCloseAt) <= new Date()) {
      return jsonError(409, "your EC position window has ended — open a new position to fight");
    }
    const potAmount = amountPerRound ?? position.amount ?? 1;
    const fund = await assertMatchFunding(addr, potAmount, rounds!);
    if (!fund.ok) {
      return fund.reason === "insufficient"
        ? jsonError(402, `operator approval ${fund.allowance} below match pot ${fund.required} — approve on the POSITION screen first`)
        : jsonError(503, "could not verify on-chain funding — retry");
    }

    // Retire the host's own stale waiting rooms so one wallet holds one code.
    await MatchRoom.deleteMany({ hostAddress: lower, status: "waiting" });

    // Unique code (retry on the vanishingly rare collision).
    let code = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateRoomCode();
      try {
        const roomId = randomUUID();
        await MatchRoom.create({
          _id: roomId,
          code: candidate,
          hostAddress: lower,
          rounds: rounds!,
          hostCharId: charId || "dreamer",
          status: "waiting",
          expiresAt: new Date(Date.now() + ROOM_TTL_MS),
        });
        code = candidate;
        break;
      } catch (err: any) {
        if (err?.code !== 11000) throw err;
      }
    }
    if (!code) return jsonError(500, "could not mint an invite code — retry");

    const room = await MatchRoom.findOne({ code }).lean();
    return Response.json({ status: "waiting", code, rounds, expiresAt: room!.expiresAt.toISOString() }, { status: 201 });
  } catch (err) {
    console.error("room create failed", err);
    return jsonError(500, "failed to create private room — try again shortly");
  }
}

/**
 * Room state polling lives on GET /api/matchmaking/status?code=DUEL-XXXX (the
 * spec's polling gate) — this route is create + cancel only.
 */

/**
 * DELETE /api/matchmaking/room?code=DUEL-XXXX&address=0x… — host cancels their
 * waiting room. Guests never need this (nothing is reserved for them).
 */
export async function DELETE(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = normalizeRoomCode(url.searchParams.get("code"));
  const addressParam = url.searchParams.get("address");
  if (!code) return jsonError(400, "invalid invite code format");
  if (!addressParam || !isAddress(addressParam)) return jsonError(400, "valid wallet address required");

  try {
    await connectToDatabase();
    const lower = normalizeAddress(addressParam).toLowerCase();
    const res = await MatchRoom.updateOne(
      { code, hostAddress: lower, status: "waiting" },
      { $set: { status: "cancelled", updatedAt: new Date() } },
    );
    if (res.modifiedCount !== 1) return jsonError(404, "waiting room not found");
    return Response.json({ status: "cancelled" });
  } catch (err) {
    console.error("room cancel failed", err);
    return jsonError(500, "failed to cancel room");
  }
}
