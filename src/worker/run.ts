import { connectToDatabase } from "@/db/connect";
import { reconcilePositions } from "@/lib/ec/position";

/**
 * DreamDuel settlement worker.
 *
 * The match game-loop resolves live inside the API (predict route reads the real
 * EC order-book oracle and completes matches). Combat matches are stats/rank
 * only — they never move money. The ONLY financial layer is the EC POSITION,
 * and this worker owns its on-chain reconciliation:
 *
 *   - `reconcilePositions()` settles each active/expired EC position once from
 *     the real on-chain EC resolution (win → stake back in full, loss →
 *     forfeited to admin) and marks it in the DB.
 *
 * Runs as: npm run worker
 */

const SWEEP_INTERVAL_MS = 15_000;

async function runOnce(): Promise<void> {
  await connectToDatabase();
  await reconcilePositions();
  console.log(`[worker] sweep complete @ ${new Date().toISOString()}`);
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
