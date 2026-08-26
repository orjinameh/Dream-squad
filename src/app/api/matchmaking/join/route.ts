import { connectToDatabase } from "@/db/connect";
import { MatchQueue } from "@/db/models/MatchQueue";
import { Match, ROUND_TIMINGS } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

const READY_TIMEOUT_MS = 30_000;
const QUEUE_TIMEOUT_MS = 120_000;

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const address = body.address as string | undefined;
  const rounds = body.rounds as number | undefined;
  const charId = body.charId as string | undefined;

  if (!address || !address.startsWith("0x")) {
    return jsonError(400, "valid wallet address required");
  }
  if (![3, 5, 7, 11].includes(rounds as number)) {
    return jsonError(400, "rounds must be 3, 5, 7, or 11");
  }

  try {
    await connectToDatabase();
    const addr = normalizeAddress(address);

    // Check for existing active match — do not allow queueing if already in a match
    const activeMatch = await Match.findOne({
      $or: [{ playerAddress: addr }, { player2Address: addr }],
      status: "ACTIVE",
    }).lean();

    if (activeMatch) {
      return Response.json({
        status: "matched",
        matchId: activeMatch._id,
        message: "Already in an active match",
      });
    }

    // Upsert queue entry — idempotent
    const existing = await MatchQueue.findOne({ address: addr, status: "searching" }).lean() as { _id: string; rounds: number; charId: string; createdAt: Date } | null;

    if (existing) {
      // Update rounds/char if changed
      if (existing.rounds !== rounds || existing.charId !== charId) {
        await MatchQueue.updateOne(
          { _id: existing._id },
          { $set: { rounds, charId, updatedAt: new Date() } }
        );
      }
      // Check if timeout
      const age = Date.now() - new Date(existing.createdAt).getTime();
      if (age > QUEUE_TIMEOUT_MS) {
        await MatchQueue.updateOne({ _id: existing._id }, { $set: { status: "matched" } });
        return Response.json({ status: "timeout", message: "Queue entry expired" });
      }
      return Response.json({ status: "searching", queueId: existing._id, age });
    }

    // Clean up any stale queue entries for this player
    await MatchQueue.deleteMany({ address: addr, status: { $in: ["searching", "matched"] } });

    // Create new queue entry
    const queueId = randomUUID();
    await MatchQueue.create({
      _id: queueId,
      address: addr,
      rounds: rounds!,
      charId: charId || "dreamer",
      status: "searching",
    });

    // Try to find a compatible opponent (same rounds, not same player, oldest first)
    const opponent = await MatchQueue.findOne({
      _id: { $ne: queueId },
      rounds: rounds,
      status: "searching",
      address: { $ne: addr },
      createdAt: { $gte: new Date(Date.now() - QUEUE_TIMEOUT_MS) },
    }).sort({ createdAt: 1 }).lean() as { _id: string; address: string; charId: string } | null;

    if (opponent) {
      // Atomically mark both as matched
      const now = new Date();
      const oppUpdate = await MatchQueue.updateOne(
        { _id: opponent._id, status: "searching" },
        { $set: { status: "matched", updatedAt: now } }
      );

      if (oppUpdate.modifiedCount === 0) {
        // Opponent was claimed by another race — just searching
        return Response.json({ status: "searching", queueId });
      }

      // Create the match
      const matchId = randomUUID();
      const nowDate = new Date();
      const deadline = new Date(nowDate.getTime() + READY_TIMEOUT_MS + ROUND_TIMINGS.ROUND_DURATION_MS);

      // Assign random rival names for display
      const RIVAL_NAMES = ["RAVEN", "CIPHER", "NOVA", "BLAZE", "PHANTOM", "STORM", "VIPER", "NEXUS", "ORBIT", "ZENITH", "PULSE", "DASH", "NIMBUS", "FROST", "APEX"];

      // Player 1 is the one who joined second (current player), Player 2 is the opponent
      // But we want "playerAddress" = current player from the client's perspective
      const p1Name = RIVAL_NAMES[Math.floor(Math.random() * RIVAL_NAMES.length)];
      const p2Name = RIVAL_NAMES[Math.floor(Math.random() * RIVAL_NAMES.length)];

      await Match.create({
        _id: matchId,
        playerAddress: addr,
        playerChar: charId || "dreamer",
        rivalName: p2Name,
        rivalChar: opponent.charId || "dreamer",
        mode: rounds === 3 ? "quick" : rounds === 5 ? "clash" : rounds === 7 ? "battle" : "war",
        totalRounds: rounds,
        currentRound: 1,
        roundPhase: "WAITING",
        roundStartTime: nowDate,
        roundDeadline: deadline,
        playerScore: 0,
        rivalScore: 0,
        winner: "player",
        rounds: [],
        playerPrediction: null,
        rivalPrediction: null,
        status: "ACTIVE",
        opponentType: "player",
        player2Address: opponent.address,
        player2Char: opponent.charId || "dreamer",
        player1Ready: false,
        player2Ready: false,
      });

      // Update both queue entries with matchId
      await MatchQueue.updateOne({ _id: queueId }, { $set: { status: "matched", matchId } });
      await MatchQueue.updateOne({ _id: opponent._id }, { $set: { status: "matched", matchId } });

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
    return Response.json({ status: "searching", queueId });
  } catch (err) {
    console.error("matchmaking join failed", err);
    return jsonError(500, "matchmaking failed");
  }
}
