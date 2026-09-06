import { Match } from "@/db/models/Match";

// A PvP match that is stuck and will never be played is abandoned so a lone
// phone (or a leftover from an earlier test/broken session) can't masquerade as
// an active match, block re-queueing, phantom-pair itself on re-join, or be
// auto-resumed as a "REJOIN MATCH". Two cases are covered:
//   1. Still WAITING with no round started 60s after it was created.
//   2. A round started but was never resolved — its deadline lapsed by 60s with
//      no resolution (both players left mid-round). A healthy round resolves at
//      its deadline via predict, which rolls the deadline forward, so this only
//      fires on genuinely abandoned games.
// NOTE: 10s was too aggressive — a mid-round oracle sweep (8s) + relay can
// legitimately hold a deadline 10-20s past expiry while settling. 60s avoids
// abandoning healthy fights.
export const STALE_WAITING_MS = 60_000;

export async function expireStaleWaitingMatches(
  addr: string,
): Promise<void> {
  const now = Date.now();
  const waitingCutoff = new Date(now - STALE_WAITING_MS);
  const startedInactivityCutoff = new Date(now - STALE_WAITING_MS);

  await Match.updateMany(
    {
      status: "ACTIVE",
      $and: [
        { $or: [{ playerAddress: addr }, { player2Address: addr }] },
        {
          $or: [
            // Never started a round within the stale window
            { roundPhase: "WAITING", rounds: { $size: 0 }, roundStartTime: { $lt: waitingCutoff } },
            // Started a round but never resolved it (left mid-round)
            { roundPhase: { $ne: "WAITING" }, roundDeadline: { $lt: startedInactivityCutoff } },
          ],
        },
      ],
    },
    { $set: { status: "ABANDONED", completedAt: new Date() } },
  );
}
