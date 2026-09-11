import { connectToDatabase } from "@/db/connect";
import { MatchQueue } from "@/db/models/MatchQueue";
import { Match } from "@/db/models/Match";
import { MatchRoom, normalizeRoomCode } from "@/db/models/MatchRoom";
import { EcPosition } from "@/db/models/EcPosition";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { expireStaleWaitingMatches } from "@/lib/matchExpiry";
import { assertMatchFunding } from "@/lib/ec/funding";
import { createPvpMatch } from "@/lib/matchmaking";
import { randomUUID } from "node:crypto";
import { isAddress } from "viem";
import { CHARACTERS } from "@/game/characters";

export const dynamic = "force-dynamic";

const QUEUE_TIMEOUT_MS = 120_000;

/**
 * Join a private room by invite code. The guest claims the waiting room
 * atomically (exactly one claim wins), then an identical PvP match is created
 * with the guest as player 1 and the host as player 2. Idempotent for either
 * party: rejoining a room you're already in returns its matchId.
 */
async function joinPrivateRoom(input: {
  code: string;
  address: string;
  charId?: string;
  amountPerRound?: number;
}): Promise<Response> {
  const validCharIds = new Set(CHARACTERS.map((c) => c.id));
  if (input.charId && (typeof input.charId !== "string" || input.charId.length > 32 || !validCharIds.has(input.charId))) {
    return jsonError(400, "invalid charId");
  }
  if (input.amountPerRound !== undefined && (!(typeof input.amountPerRound === "number") || !(input.amountPerRound > 0) || input.amountPerRound > 100000)) {
    return jsonError(400, "amountPerRound must be a positive number");
  }

  try {
    await connectToDatabase();
    const addr = normalizeAddress(input.address);
    const lower = addr.toLowerCase();

    const room = await MatchRoom.findOne({ code: input.code }).lean();
    if (!room) return jsonError(404, "invite code not found");
    if (room.status === "cancelled" || new Date(room.expiresAt).getTime() <= Date.now()) {
      return jsonError(410, "invite code expired — ask the host for a fresh one");
    }
    if (room.hostAddress === lower && room.status === "waiting") {
      return jsonError(400, "you can't join your own room — share the code with your rival");
    }
    // Idempotent rejoin for either party of an already-matched room.
    if (room.status === "matched" && room.matchId && (room.hostAddress === lower || room.guestAddress === lower)) {
      return Response.json({ status: "matched", matchId: room.matchId });
    }
    if (room.status !== "waiting") {
      return jsonError(410, "invite code already used");
    }

    // Same gates as the public queue: no active match, funded position, funded pot.
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
    const joinAmount = input.amountPerRound ?? position.amount ?? 1;
    const fund = await assertMatchFunding(addr, joinAmount, room.rounds);
    if (!fund.ok) {
      return fund.reason === "insufficient"
        ? jsonError(402, `operator approval ${fund.allowance} below match pot ${fund.required} — approve on the POSITION screen first`)
        : jsonError(503, "could not verify on-chain funding — retry");
    }

    // DUAL-WALLET VERIFICATION: the host's approval must independently cover
    // their side too. Only when BOTH handshakes pass may the room activate.
    const hostPosition = await EcPosition.findOne({ address: room.hostAddress, status: "ACTIVE" }).sort({ createdAt: -1 }).lean();
    if (!hostPosition || (hostPosition.windowCloseAt && new Date(hostPosition.windowCloseAt) <= new Date())) {
      return jsonError(409, "host funding lapsed — ask the host for a fresh code");
    }
    const hostFund = await assertMatchFunding(
      room.hostAddress as `0x${string}`,
      hostPosition.amount ?? 1,
      room.rounds,
    );
    if (!hostFund.ok) {
      return hostFund.reason === "insufficient"
        ? jsonError(402, "host funding approval short of the match pot — ask the host to re-approve")
        : jsonError(503, "could not verify host funding — retry");
    }

    // Atomic claim: exactly one guest wins the room.
    const claimed = await MatchRoom.updateOne(
      { _id: room._id, status: "waiting" },
      { $set: { status: "matched", guestAddress: lower, updatedAt: new Date() } },
    );
    if (claimed.modifiedCount !== 1) {
      // Lost the race — whoever won either matched it (return it if we're a
      // party) or took it (gone for us).
      const current = await MatchRoom.findById(room._id).lean();
      if (current?.status === "matched" && current.matchId && (current.hostAddress === lower || current.guestAddress === lower)) {
        return Response.json({ status: "matched", matchId: current.matchId });
      }
      return jsonError(410, "invite code already used");
    }

    const { matchId } = await createPvpMatch({
      address: addr,
      charId: input.charId || "dreamer",
      opponentAddress: room.hostAddress,
      opponentCharId: room.hostCharId || "dreamer",
      rounds: room.rounds,
      position: { _id: position._id, amount: position.amount, windowId: position.windowId ?? undefined, direction: position.direction },
      amountPerRound: joinAmount,
    });
    await MatchRoom.updateOne({ _id: room._id }, { $set: { matchId } });
    console.log(`[room] code=${room.code} matched=${matchId} guest=${addr.slice(0, 6)} host=${room.hostAddress.slice(0, 6)}`);

    return Response.json({
      status: "matched",
      matchId,
      opponent: { address: room.hostAddress, charId: room.hostCharId },
    });
  } catch (err) {
    console.error("private room join failed", err);
    return jsonError(500, "failed to join private room — try again shortly");
  }
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const address = body.address as string | undefined;
  const rounds = body.rounds as number | undefined;
  const charId = body.charId as string | undefined;
  const amountPerRound = body.amountPerRound as number | undefined;
  const roomCode = normalizeRoomCode(body.code);

  if (!address || !isAddress(address)) {
    return jsonError(400, "valid wallet address required");
  }
  // Private-room join by invite code: rounds/amount ride the host's room.
  if (roomCode) {
    return joinPrivateRoom({ code: roomCode, address, charId, amountPerRound });
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

    // Check for existing active match — do not allow queueing if already in a
    // match, UNLESS it's an abandoned PvP match still WAITING with no round
    // started past the stale window, in which case expire it so it can't block
    // a real pair (or phantom-pair a lone player on a re-join).
    await expireStaleWaitingMatches(addr);

    const activeMatch = await Match.findOne({
      $or: [{ playerAddress: { $in: [addr, lower] } }, { player2Address: { $in: [addr, lower] } }],
      status: "ACTIVE",
    }).lean();

    if (activeMatch) {
      return Response.json({
        status: "matched",
        matchId: activeMatch._id,
        message: "Already in an active match",
      });
    }

    // Must have an ACTIVE EC POSITION to fight (PvP rides the position, same as
    // the bot match path in create/route.ts). No position => no queueing.
    const position = await EcPosition.findOne({ address: lower, status: "ACTIVE" }).sort({ createdAt: -1 }).lean();
    if (!position) {
      return jsonError(409, "no active EC position — stake one first on the POSITION screen");
    }
    if (position.windowCloseAt && new Date(position.windowCloseAt) <= new Date()) {
      return jsonError(409, "your EC position window has ended — open a new position to fight");
    }

    // CONFIRM FUND BEFORE QUEUEING: verify the on-chain operator approval
    // covers this match's pot (position size, client-confirmed) — a DB
    // position alone is not proof.
    const joinAmount = amountPerRound ?? position.amount ?? 1;
    const fund = await assertMatchFunding(addr, joinAmount, rounds!);
    if (!fund.ok) {
      return fund.reason === "insufficient"
        ? jsonError(402, `operator approval ${fund.allowance} below match pot ${fund.required} — approve on the POSITION screen first`)
        : jsonError(503, "could not verify on-chain funding — retry");
    }

    // Ensure the player has a fresh "searching" queue entry (create if missing,
    // refresh if stale/timed-out, keep if valid). There may be at most one
    // "searching" entry per address (partial unique index).
    // Queue stores lowercase — always query/create with lowercase.
    let queueId: string;
    const existing = await MatchQueue.findOne({ address: lower, status: "searching" }).lean() as { _id: string; rounds: number; charId: string; createdAt: Date } | null;

    if (existing) {
      const age = Date.now() - new Date(existing.createdAt).getTime();
      if (age > QUEUE_TIMEOUT_MS) {
        // Expired — replace it so a stale entry can never block re-queueing.
        await MatchQueue.findOneAndUpdate(
          { _id: existing._id, status: "searching" },
          { $set: { status: "matched", updatedAt: new Date() } },
        );
        queueId = randomUUID();
        await MatchQueue.create({ _id: queueId, address: lower, rounds: rounds!, charId: charId || "dreamer", status: "searching" });
      } else {
        queueId = existing._id;
        if (existing.rounds !== rounds || existing.charId !== charId) {
          await MatchQueue.updateOne({ _id: existing._id }, { $set: { rounds, charId, updatedAt: new Date() } });
        }
      }
    } else {
      // Clean up any fully stale entries for this player, then create fresh.
      await MatchQueue.deleteMany({ address: { $in: [addr, lower] }, status: { $in: ["searching", "matched"] } });
      queueId = randomUUID();
      await MatchQueue.create({ _id: queueId, address: lower, rounds: rounds!, charId: charId || "dreamer", status: "searching" });
    }

    // ALWAYS attempt to pair after ensuring the queue entry, so re-joining or a
    // leftover entry never strands a player in "searching" without a rival.
    const opponent = await MatchQueue.findOne({
      _id: { $ne: queueId },
      rounds: rounds,
      status: "searching",
      address: { $ne: lower, $nin: [addr] },
      createdAt: { $gte: new Date(Date.now() - QUEUE_TIMEOUT_MS) },
    }).sort({ createdAt: 1 }).lean() as { _id: string; address: string; charId: string } | null;

    let ageNow = Date.now() - new Date(existing?.createdAt ?? Date.now()).getTime();

    if (opponent) {
      // Atomically mark both as matched
      const now = new Date();
      const oppUpdate = await MatchQueue.updateOne(
        { _id: opponent._id, status: "searching" },
        { $set: { status: "matched", updatedAt: now } }
      );

      if (oppUpdate.modifiedCount === 0) {
        // Opponent was claimed by another race — just searching.
        ageNow = existing ? Date.now() - new Date(existing.createdAt).getTime() : 0;
        return Response.json({ status: "searching", queueId, age: ageNow });
      }

      // Create the match (shared PvP creator — identical to private rooms).
      // Player 1 is the one who joined second (current player), Player 2 is
      // the opponent. "playerAddress" = current player from the client's
      // perspective.
      const { matchId } = await createPvpMatch({
        address: addr,
        charId: charId || "dreamer",
        opponentAddress: opponent.address,
        opponentCharId: opponent.charId || "dreamer",
        rounds: rounds as 3 | 5 | 7 | 11,
        position: { _id: position._id, amount: position.amount, windowId: position.windowId ?? undefined, direction: position.direction },
        amountPerRound: joinAmount,
      });

      // Update both queue entries with matchId
      await MatchQueue.updateOne({ _id: queueId }, { $set: { status: "matched", matchId } });
      await MatchQueue.updateOne({ _id: opponent._id }, { $set: { status: "matched", matchId } });
      console.log(`[join] created match=${matchId} cur=${addr.slice(0,6)} opp=${opponent.address.slice(0,6)}`);

      return Response.json({
        status: "matched",
        matchId,
        opponent: {
          address: opponent.address,
          charId: opponent.charId,
        },
      });
    }

    // No opponent found — still searching
    console.log(`[join] addr=${addr.slice(0,6)} searching queue=${queueId}`);
    return Response.json({ status: "searching", queueId, age: ageNow });
  } catch (err) {
    console.error("matchmaking join failed", err);
    return jsonError(500, "matchmaking failed — try again shortly");
  }
}
