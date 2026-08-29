import { connectToDatabase } from "@/db/connect";
import { MatchQueue } from "@/db/models/MatchQueue";
import { Match } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";

export const dynamic = "force-dynamic";

const READY_TIMEOUT_MS = 30_000;
const READY_EXPIRE_MS = READY_TIMEOUT_MS + 15_000;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");

  if (!address || !address.startsWith("0x")) {
    return jsonError(400, "address required");
  }

  try {
    await connectToDatabase();
    const addr = normalizeAddress(address);

    // Expire any abandoned PvP match still stuck in WAITING past its readiness
    // window so it can't masquerade as an active match and block re-queueing.
    await Match.updateMany(
      {
        $or: [{ playerAddress: addr }, { player2Address: addr }],
        status: "ACTIVE",
        roundPhase: "WAITING",
        roundDeadline: { $lt: new Date(Date.now() - READY_EXPIRE_MS) },
      },
      { $set: { status: "COMPLETED", completedAt: new Date(), winner: "draw" } },
    );

    // Check for active match first
    const activeMatch = await Match.findOne({
      $or: [{ playerAddress: addr }, { player2Address: addr }],
      status: "ACTIVE",
    }).lean();

    if (activeMatch) {
      return Response.json({
        status: "matched",
        matchId: activeMatch._id,
        opponentType: activeMatch.opponentType,
      });
    }

    // Check queue status
    const queueEntry = await MatchQueue.findOne({ address: addr, status: "searching" }).lean() as { _id: string; rounds: number; createdAt: Date } | null;

    if (!queueEntry) {
      return Response.json({ status: "idle" });
    }

    const age = Date.now() - new Date(queueEntry.createdAt).getTime();
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
