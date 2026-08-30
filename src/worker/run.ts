import { connectToDatabase } from "@/db/connect";
import { Match, type EscrowStatus } from "@/db/models/Match";
import { matchInfo } from "@/lib/ec/escrow";
import { settlePvpMatchEscrow } from "@/lib/ec/settleMatch";

/**
 * DreamDuel settlement worker.
 *
 * The match game-loop itself resolves live inside the API (predict route reads
 * the real EC order-book oracle and completes matches). This worker owns the
 * on-chain reconciliation that the request path must never block on:
 *
 *   - Sweep completed PvP matches whose pot hasn't been paid and settle the
 *     DreamDuel escrow to the real winner.
 *   - Sync escrow state (settled/drawn) back onto the match so retries are
 *     idempotent.
 *   - Leave under-funded lobbies (not both stakes) untouched for the players'
 *     self-serve refund path — the contract guards prevent any payout unless
 *     both players actually staked.
 *
 * Runs as: npm run worker
 */

const SWEEP_INTERVAL_MS = 15_000;

async function setEscrowStatus(id: string, status: EscrowStatus): Promise<void> {
  try {
    await Match.updateOne({ _id: id }, { $set: { escrowStatus: status } });
  } catch (err) {
    console.error(`[worker] failed to mark escrowStatus=${status} for ${id}`, err);
  }
}

interface OnchainMatch {
  settled?: boolean;
  drawn?: boolean;
  stakedA?: boolean;
  stakedB?: boolean;
}

async function sweepCompletedMatches(): Promise<void> {
  const pending = await Match.find({
    opponentType: "player",
    status: "COMPLETED",
    escrowStatus: { $nin: ["SETTLED", "DRAWN"] },
  });

  for (const match of pending) {
    const id = match._id;
    try {
      let onchain: OnchainMatch | null = null;
      try {
        onchain = (await matchInfo(id)) as OnchainMatch;
      } catch {
        onchain = null;
      }

      if (onchain?.settled) {
        await setEscrowStatus(id, "SETTLED");
        continue;
      }
      if (onchain?.drawn) {
        await setEscrowStatus(id, "DRAWN");
        continue;
      }

      // Both players must have staked on-chain before the escrow will pay out.
      // If not fully funded, leave it for the participants' self-serve refund.
      if (!onchain?.stakedA || !onchain?.stakedB) {
        continue;
      }

      const result = await settlePvpMatchEscrow(match.toObject());
      if (result === "skipped") {
        console.warn(`[worker] settle skipped (maybe not real PvP / no winner) match=${id}`);
      }
    } catch (err) {
      console.error(`[worker] sweep failed for match=${id}`, err);
    }
  }
}

async function runOnce(): Promise<void> {
  await connectToDatabase();
  await sweepCompletedMatches();
  console.log(`[worker] sweep complete @ ${new Date().toISOString()}`);
}

async function main(): Promise<void> {
  console.log("[worker] DreamDuel settlement worker starting");
  await runOnce();
  setInterval(() => {
    runOnce().catch((err) => console.error("[worker] tick failed", err));
  }, SWEEP_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
