import { connectToDatabase } from "@/db/connect";
import { MatchQueue } from "@/db/models/MatchQueue";
import { Match } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { expireStaleWaitingMatches } from "@/lib/matchExpiry";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");

  if (!address || !address.startsWith("0x")) {
    return jsonError(400, "address required");
  }

  try {
    await connectToDatabase();
    const addr = normalizeAddress(address);

    // Expire any abandoned PvP match still stuck in WAITING past its 10s stale
    // window so it can't masquerade as an active match and block re-queueing.
    await expireStaleWaitingMatches(addr);

    // Check for active match first
    const activeMatch = await Match.findOne({
      $or: [{ playerAddress: addr }, { player2Address: addr }],
      status: "ACTIVE",
    }).lean();

    if (activeMatch) {
      console.log(`[status] addr=${addr.slice(0,6)} matched match=${activeMatch._id} phase=${activeMatch.roundPhase}`);
      return Response.json({
        status: "matched",
        matchId: activeMatch._id,
        opponentType: activeMatch.opponentType,
      });
    }

    // Check queue status
    const queueEntry = await MatchQueue.findOne({ address: addr, status: "searching" }).lean() as { _id: string; rounds: number; createdAt: Date } | null;

    if (!queueEntry) {
      const anyEntry = await MatchQueue.findOne({ address: addr }).exec();
      console.log(`[status] addr=${addr.slice(0,6)} idle (no active, no searching; otherQ=${anyEntry ? anyEntry.status : "none"})`);
      return Response.json({ status: "idle" });
    }

    const age = Date.now() - new Date(queueEntry.createdAt).getTime();
    console.log(`[status] addr=${addr.slice(0,6)} searching age=${age}`);
    return Response.json({
      status: "searching",
      queueId: queueEntry._id,
      rounds: queueEntry.rounds,
      age,
    });
  } catch (err) {
    console.error("matchmaking status failed", err);
    return jsonError(500, "failed to check status");
  }
}
