import { connectToDatabase } from "@/db/connect";
import { MatchQueue } from "@/db/models/MatchQueue";
import { Match } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const address = body.address as string | undefined;

  if (!address || !address.startsWith("0x")) {
    return jsonError(400, "valid wallet address required");
  }

  try {
    await connectToDatabase();
    const addr = normalizeAddress(address);
    await MatchQueue.deleteMany({ address: addr, status: { $in: ["searching", "matched"] } });

    // Abandon any active match this player is in that is still in WAITING
    // (i.e. never started). This ensures leaving actually cancels the match —
    // otherwise the stale ACTIVE/WAITING record persists and a later join gets
    // routed straight back into it, phantom-re-pairing two players who both
    // already left.
    await Match.updateMany(
      {
        $or: [{ playerAddress: addr }, { player2Address: addr }],
        status: "ACTIVE",
        roundPhase: "WAITING",
      },
      { $set: { status: "COMPLETED", completedAt: new Date(), winner: "draw" } },
    );

    return Response.json({ status: "left" });
  } catch (err) {
    console.error("matchmaking leave failed", err);
    return jsonError(500, "failed to leave queue");
  }
}
