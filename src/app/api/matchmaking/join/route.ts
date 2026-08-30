import { connectToDatabase } from "@/db/connect";
import { MatchQueue } from "@/db/models/MatchQueue";
import { Match, ROUND_TIMINGS } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { expireStaleWaitingMatches } from "@/lib/matchExpiry";
import { openMatchOnchain } from "@/lib/ec/escrow";
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

    // Check for existing active match — do not allow queueing if already in a
    // match, UNLESS it's an abandoned PvP match still WAITING with no round
    // started past the stale window, in which case expire it so it can't block
    // a real pair (or phantom-pair a lone player on a re-join).
    await expireStaleWaitingMatches(addr);

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

    // Ensure the player has a fresh "searching" queue entry (create if missing,
    // refresh if stale/timed-out, keep if valid). There may be at most one
    // "searching" entry per address (partial unique index).
    let queueId: string;
    const existing = await MatchQueue.findOne({ address: addr, status: "searching" }).lean() as { _id: string; rounds: number; charId: string; createdAt: Date } | null;

    if (existing) {
      const age = Date.now() - new Date(existing.createdAt).getTime();
      if (age > QUEUE_TIMEOUT_MS) {
        // Expired — replace it so a stale entry can never block re-queueing.
        await MatchQueue.findOneAndUpdate(
          { _id: existing._id, status: "searching" },
          { $set: { status: "matched", updatedAt: new Date() } },
        );
        queueId = randomUUID();
        await MatchQueue.create({ _id: queueId, address: addr, rounds: rounds!, charId: charId || "dreamer", status: "searching" });
      } else {
        queueId = existing._id;
        if (existing.rounds !== rounds || existing.charId !== charId) {
          await MatchQueue.updateOne({ _id: existing._id }, { $set: { rounds, charId, updatedAt: new Date() } });
        }
      }
    } else {
      // Clean up any fully stale entries for this player, then create fresh.
      await MatchQueue.deleteMany({ address: addr, status: { $in: ["searching", "matched"] } });
      queueId = randomUUID();
      await MatchQueue.create({ _id: queueId, address: addr, rounds: rounds!, charId: charId || "dreamer", status: "searching" });
    }

    // ALWAYS attempt to pair after ensuring the queue entry, so re-joining or a
    // leftover entry never strands a player in "searching" without a rival.
    const opponent = await MatchQueue.findOne({
      _id: { $ne: queueId },
      rounds: rounds,
      status: "searching",
      address: { $ne: addr },
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

      // Create the match
      const matchId = randomUUID();
      const nowDate = new Date();
      const deadline = new Date(nowDate.getTime() + READY_TIMEOUT_MS + ROUND_TIMINGS.ROUND_DURATION_MS);

      // Assign random rival names for display
      const RIVAL_NAMES = ["RAVEN", "CIPHER", "NOVA", "BLAZE", "PHANTOM", "STORM", "VIPER", "NEXUS", "ORBIT", "ZENITH", "PULSE", "DASH", "NIMBUS", "FROST", "APEX"];

      // Player 1 is the one who joined second (current player), Player 2 is the opponent
      // But we want "playerAddress" = current player from the client's perspective
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
      console.log(`[join] created match=${matchId} cur=${addr.slice(0,6)} opp=${opponent.address.slice(0,6)}`);

      // Open the on-chain escrow so both players can pledge tUSDC (real PvP
      // money). If this write fails (transient RPC), the settlement worker will
      // reconcile on match completion — never fabricate a secure state.
      try {
        await openMatchOnchain(matchId, addr as `0x${string}`, opponent.address as `0x${string}`);
        console.log(`[join] escrow opened match=${matchId}`);
      } catch (escrowErr) {
        console.error("[join] escrow open failed (will reconcile)", escrowErr);
      }

      return Response.json({
        status: "matched",
        matchId,
        escrowReady: true,
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
    const detail = err instanceof Error ? err.message : "unknown error";
    return jsonError(500, `matchmaking failed: ${detail}`);
  }
}
