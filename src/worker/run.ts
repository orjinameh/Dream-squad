import { connectToDatabase } from "@/db/connect";
import { reconcilePositions } from "@/lib/ec/position";
import { settleRoundStakes } from "@/lib/ec/settleRoundStakes";

/**
 * DreamDuel settlement worker.
 *
 * Two financial layers are reconciled here against the REAL on-chain EC venue:
 *
 *   - `reconcilePositions()` settles each active/expired EC position once from
 *     the real on-chain EC resolution (win → stake back in full, loss →
 *     forfeited to admin) and marks it in the DB.
 *   - `settleRoundStakes()` settles each per-round match stake whose pinned
 *     arena window RESOLVED on-chain: won/refunded sides are redeemed 1:1/0.5
 *     via the operator, net P&L is stored on the round's checkpoint.
 *
 * Runs as: npm run worker
 */

const SWEEP_INTERVAL_MS = 15_000;

async function runOnce(): Promise<void> {
  await connectToDatabase();
  await reconcilePositions();
  const settled = await settleRoundStakes();
  console.log(`[worker] sweep complete @ ${new Date().toISOString()}` + (settled > 0 ? ` (settled ${settled} round stake(s))` : ""));
}

async function main(): Promise<void> {
  console.log("[worker] DreamDuel settlement worker starting");

  let handle: NodeJS.Timeout | null = null;
  let sweeping = false;
  let stopping = false;

  const tick = async (): Promise<void> => {
    if (stopping || sweeping) return; // no overlap; drain on shutdown
    sweeping = true;
    try {
      await runOnce();
    } catch (err) {
      console.error("[worker] tick failed", err);
    } finally {
      sweeping = false;
    }
  };

  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    console.log("[worker] stopping (in-flight sweep will drain)");
    if (handle) clearInterval(handle);
  };

  process.on("SIGTERM", () => { stop(); process.exit(0); });
  process.on("SIGINT", () => { stop(); process.exit(0); });

  await runOnce();
  handle = setInterval(() => { tick().catch((err) => console.error("[worker] tick failed", err)); }, SWEEP_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
