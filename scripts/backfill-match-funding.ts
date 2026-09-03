import { connectToDatabase } from "../src/db/connect";
import { Match } from "../src/db/models/Match";

/**
 * Backfill the `funded` ghost-funding field for matches created before the
 * funding gate was introduced.
 *
 * The gate only ever affects ACTIVE bot matches (predict/state return early for
 * non-ACTIVE), so this is cosmetic-consistency + a data-cleanup pass:
 *   - COMPLETED / ABANDONED matches: mark `funded: true` so the data is honest
 *     (their fight already finished; they will never be gated again).
 *   - ACTIVE bot matches: leave as-is (they must actually fund the ghost before
 *     resolving, which is the whole point of the gate). They are recoverable via
 *     the existing ghost fund relay if a player picks one back up mid-flight.
 *
 * Run (point MONGODB_URI at the target DB, e.g. the Vercel prod database):
 *   npx tsx scripts/backfill-match-funding.ts
 */
async function main() {
  await connectToDatabase();

  const closed = await Match.updateMany(
    { status: { $in: ["COMPLETED", "ABANDONED"] }, funded: { $ne: true } },
    { $set: { funded: true } },
  );

  const activeBotUnfunded = await Match.countDocuments({
    status: "ACTIVE",
    opponentType: "bot",
    funded: { $ne: true },
  });

  console.log("[backfill] closed matches marked funded:", closed.modifiedCount);
  console.log("[backfill] ACTIVE bot matches left to fund (not gated into closure):", activeBotUnfunded);

  // Optionally surface ACTIVE bot matches that predate the gate so an operator
  // can inspect whether any are genuinely abandoned rather than mid-fight.
  const stale = await Match.find(
    { status: "ACTIVE", opponentType: "bot", funded: { $ne: true } },
    { _id: 1, currentRound: 1, totalRounds: 1, roundPhase: 1, roundDeadline: 1, playerAddress: 1 },
  ).sort({ createdAt: -1 }).limit(20);
  console.log("[backfill] sample of pre-gate ACTIVE bot matches held:", JSON.stringify(stale, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
