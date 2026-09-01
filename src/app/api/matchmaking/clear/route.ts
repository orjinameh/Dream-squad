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
 * If ADMIN_TOKEN is configured (recommended for any shared/staged deployment),
 * a request must present X-Admin-Token matching it; otherwise the endpoint is
 * served open for local single-user development.
 */
export async function POST(req: Request): Promise<Response> {
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken) {
    const provided = req.headers.get("x-admin-token");
    if (provided !== adminToken) {
      return Response.json({ cleared: false, error: "unauthorized" }, { status: 401 });
    }
  }

  try {
    await connectToDatabase();

    const queueCleared = await MatchQueue.deleteMany({});

    // Abandon ANY open ACTIVE PvP match (started or not) — this is the manual
    // reset button, so every leftover match is scrubbed; these are the ones
    // that otherwise show up as "REJOIN MATCH" or hijack a fresh pairing.
    const abandoned = await Match.updateMany(
      {
        opponentType: "player",
        status: "ACTIVE",
      },
      { $set: { status: "ABANDONED", completedAt: new Date() } },
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
