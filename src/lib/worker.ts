import { connectToDatabase } from "../db/connect";
import { Batch, type BatchDoc } from "../db/models/Batch";
import { Trade, type TradeDoc } from "../db/models/Trade";
import { executeTradeOnChain, checkOperatorWarmup } from "./operator";

// ─── Error normaliser ─────────────────────────────────────────────────────────
// Keeps trade error messages short and constant for downstream UI rendering.

export function normalizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("INSUFFICIENT_FUNDS")) return "INSUFFICIENT_FUNDS";
  if (msg.includes("Out of gas")) return "OUT_OF_GAS";
  if (msg.includes("OnlyApprovedContracts")) return "ONLY_APPROVED_CONTRACTS";
  if (msg.includes("QuantityBelowMinimum")) return "QUANTITY_BELOW_MINIMUM";
  if (msg.includes("expired")) return "ORDER_EXPIRED";
  return msg.slice(0, 300);
}

// ─── Executor interface (DI seam for tests) ────────────────────────────────────

export interface ExecutorDeps {
  /** Execute one trade on-chain.  Returns txHash on success, throws on revert. */
  executeTrade: (market: string, user: string, amount: number, dir: "BUY" | "SELL") => Promise<string>;
  /** Verify operator wallet has enough gas before a sweep. */
  checkWarmup?: () => Promise<{ ready: boolean; balanceSTT: number }>;
  /** Hook called after every claim attempt (success or none). */
  onIdle?: () => void;
}

// ─── Atomic batch claim ────────────────────────────────────────────────────────
// findOneAndUpdate is atomic at the Mongo level: two workers calling this
// concurrently on the same batch will never both get a result back — only one
// receives the document.

export async function claimNextBatch(): Promise<BatchDoc | null> {
  return Batch.findOneAndUpdate(
    { status: "OPEN", closesAt: { $lte: new Date() } },
    { $set: { status: "PROCESSING" } },
    { new: true, sort: { closesAt: 1 } }, // oldest first
  );
}

// ─── Execute all trades in a claimed batch ─────────────────────────────────────

export interface BatchResult {
  batchId: string;
  succeeded: number;
  failed: number;
  skippedEmpty: boolean;
}

export async function executeBatch(batch: BatchDoc, deps: ExecutorDeps): Promise<BatchResult> {
  const trades = await Trade.find({ batchId: batch._id, status: "PENDING" })
    .sort({ createdAt: 1 })
    .lean();

  let succeeded = 0;
  let failed = 0;

  for (const trade of trades) {
    try {
      const txHash = await deps.executeTrade(batch.market, trade.userAddress, trade.amount, batch.direction);
      await Trade.findByIdAndUpdate(trade._id, {
        $set: { status: "EXECUTED", txHash, executedAt: new Date() },
      });
      succeeded++;
    } catch (err) {
      await Trade.findByIdAndUpdate(trade._id, {
        $set: { status: "FAILED", errorMessage: normalizeError(err) },
      });
      failed++;
    }
  }

  const allFailed = trades.length > 0 && failed === trades.length;
  await Batch.findByIdAndUpdate(batch._id, {
    $set: { status: allFailed ? "FAILED" : "EXECUTED" },
  });

  return { batchId: batch._id, succeeded, failed, skippedEmpty: trades.length === 0 };
}

// ─── Single poll-cycle ─────────────────────────────────────────────────────────
// Returns null when no batch is ready.  The caller drives the loop.

export async function runOnce(deps: ExecutorDeps): Promise<{ claimed: boolean; result?: BatchResult }> {
  const batch = await claimNextBatch();
  if (!batch) return { claimed: false };

  // Operator warmup gate: if the operator wallet ran out of gas mid-session
  // (unlikely but possible on testnet faucets), we must NOT leave the batch
  // stuck in PROCESSING.
  if (deps.checkWarmup) {
    try {
      const w = await deps.checkWarmup();
      if (!w.ready) {
        await Batch.findByIdAndUpdate(batch._id, { $set: { status: "FAILED" } });
        return {
          claimed: true,
          result: { batchId: batch._id, succeeded: 0, failed: 0, skippedEmpty: false },
        };
      }
    } catch {
      // Network blip on the RPC read — safest to abort this cycle and retry
      // on the next poll rather than marking the batch FAILED.
      await Batch.findByIdAndUpdate(batch._id, { $set: { status: "OPEN" } });
      return { claimed: false };
    }
  }

  const result = await executeBatch(batch, deps);
  return { claimed: true, result };
}

// ─── Worker loop (production wiring) ───────────────────────────────────────────

const POLL_INTERVAL_MS = 1_500;
const MAX_CONSECUTIVE_ERRORS = 5;

export async function startWorker(deps: ExecutorDeps): Promise<void> {
  await connectToDatabase();
  let consecutiveErrors = 0;
  let running = true;

  const stop = () => { running = false; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (running) {
    try {
      await runOnce(deps);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      console.error(`[executor] loop error (${consecutiveErrors}):`, err);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error("[executor] too many consecutive errors, shutting down");
        break;
      }
    }
    if (running) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  console.log("[executor] shut down cleanly");
}

// ─── Default (production) deps ─────────────────────────────────────────────────

export function createProductionDeps(): ExecutorDeps {
  return {
    executeTrade: executeTradeOnChain,
    checkWarmup: checkOperatorWarmup,
  };
}
