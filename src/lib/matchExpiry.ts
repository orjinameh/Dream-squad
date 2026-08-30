import { Match } from "@/db/models/Match";

// A PvP match that has not started a round (still WAITING, no rounds played)
// within this window is treated as abandoned and expired. This prevents a lone
// phone's stale WAITING match from masquerading as an active match, blocking
// re-queueing, phantom-pairing itself on re-join, or being auto-resumed.
export const STALE_WAITING_MS = 10_000;

export async function expireStaleWaitingMatches(
  addr: string,
): Promise<void> {
  await Match.updateMany(
    {
      $or: [{ playerAddress: addr }, { player2Address: addr }],
      status: "ACTIVE",
      roundPhase: "WAITING",
      rounds: { $size: 0 },
      roundStartTime: { $lt: new Date(Date.now() - STALE_WAITING_MS) },
    },
    { $set: { status: "COMPLETED", completedAt: new Date(), winner: "draw" } },
  );
}
