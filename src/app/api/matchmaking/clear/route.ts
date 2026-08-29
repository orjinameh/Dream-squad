import { connectToDatabase } from "@/db/connect";
import { MatchQueue } from "@/db/models/MatchQueue";
import { Match } from "@/db/models/Match";

export const dynamic = "force-dynamic";

/**
 * Developer/test utility: wipe all matchmaking state so a fresh two-device test
 * starts from a clean slate. Clears the pairing queue entirely and abandons any
 * open PvP match still waiting for readiness (so it can never phantom re-pair a
 * player against a leftover opponent).
 *
 * This is intentionally unauthenticated: the app is a single-user hackathon
 * project and leaving a stale queue entry behind (e.g. a closed tab) otherwise
 * creates phantom pairings that block real two-player matches.
 */
export async function POST(): Promise<Response> {
  try {
    await connectToDatabase();

    const queueCleared = await MatchQueue.deleteMany({});

    // Abandon open PvP matches that never started (still WAITING for readiness)
    // OR are freshly ACTIVE but stale — these are the ones that hijack pairing.
    const abandoned = await Match.updateMany(
      {
        opponentType: "player",
        status: "ACTIVE",
        $or: [{ roundPhase: "WAITING" }, { roundStartTime: { $lt: new Date(Date.now() - 60_000) } }],
      },
      { $set: { status: "COMPLETED", completedAt: new Date(), winner: "draw" } },
    );

    return Response.json({
      cleared: true,
      queueEntriesDeleted: queueCleared.deletedCount,
      matchesAbandoned: abandoned.modifiedCount,
    });
  } catch (err) {
    console.error("matchmaking clear failed", err);
    const detail = err instanceof Error ? err.message : "unknown error";
    return Response.json({ cleared: false, error: detail }, { status: 500 });
  }
}
