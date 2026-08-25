import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { Batch } from "../src/db/models/Batch.js";
import { Trade } from "../src/db/models/Trade.js";
import { claimNextBatch, executeBatch, runOnce, normalizeError } from "../src/lib/worker.js";
import type { ExecutorDeps, BatchResult } from "../src/lib/worker.js";

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

const CREATOR = "0x9196d7670eea0CB723af11465d4285541a2eA86a";
const JOINER_A = "0xdd68998C099f7570E59019ae35469E5603cEDA11";
const JOINER_B = "0x66D913034C8F5A2C096c706C4f437A59ec73f016";

async function createOpenBatch(id: string, closesAtOffsetMs = -1_000): Promise<void> {
  await Batch.create({
    _id: id,
    creatorAddress: CREATOR,
    market: "SOMI:USDso",
    direction: "BUY",
    status: "OPEN",
    opensAt: new Date(Date.now() - 10_000),
    closesAt: new Date(Date.now() + closesAtOffsetMs), // negative = already expired
    totalPool: 0,
  });
}

async function joinPledge(batchId: string, userAddress: string, amount: number) {
  await Batch.updateOne({ _id: batchId }, { $inc: { totalPool: amount } });
  return Trade.create({ batchId, userAddress, amount, status: "PENDING" });
}

function makeDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    executeTrade: async (market, user, amount) => `0xtx_${market}_${user.slice(0, 6)}_${amount}`,
    checkWarmup: async () => ({ ready: true, balanceSTT: 1 }),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("claimNextBatch", () => {
  it("claims the oldest expired OPEN batch and transitions it to PROCESSING", async () => {
    await createOpenBatch("batch-1");
    const batch = await claimNextBatch();
    expect(batch).not.toBeNull();
    expect(batch!._id).toBe("batch-1");
    expect(batch!.status).toBe("PROCESSING");
  });

  it("returns null when no batch is claimable", async () => {
    // All batches already claimed or not yet expired
    const result = await claimNextBatch();
    expect(result).toBeNull();
  });

  it("only one of two concurrent claims succeeds (atomic claim)", async () => {
    await createOpenBatch("batch-race");
    const results = await Promise.all([claimNextBatch(), claimNextBatch()]);
    const claimed = results.filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!._id).toBe("batch-race");

    // Second poll sees nothing
    const recheck = await claimNextBatch();
    expect(recheck).toBeNull();
  });
});

describe("executeBatch", () => {
  it("executes all trades sequentially and marks the batch EXECUTED", async () => {
    await createOpenBatch("batch-seq");
    await joinPledge("batch-seq", CREATOR, 1);
    await joinPledge("batch-seq", JOINER_A, 2);
    await joinPledge("batch-seq", JOINER_B, 3);

    const executed: string[] = [];
    const deps = makeDeps({
      executeTrade: async (m, u, amt) => {
        executed.push(u);
        return `0xtx_ok_${u.slice(2, 8)}`;
      },
    });

    const batch = (await Batch.findById("batch-seq"))!;
    const result = await executeBatch(batch, deps);

    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.skippedEmpty).toBe(false);
    expect(executed).toEqual([CREATOR, JOINER_A, JOINER_B]); // ordered by createdAt

    const trades = await Trade.find({ batchId: "batch-seq" }).sort({ createdAt: 1 });
    expect(trades.every((t) => t.status === "EXECUTED")).toBe(true);
    expect(trades.every((t) => t.txHash?.startsWith("0xtx_ok_"))).toBe(true);

    const updated = await Batch.findById("batch-seq");
    expect(updated!.status).toBe("EXECUTED");
  });

  it("isolates per-trade failures: some EXECUTED, some FAILED", async () => {
    await createOpenBatch("batch-partial");
    await joinPledge("batch-partial", CREATOR, 1);
    await joinPledge("batch-partial", JOINER_A, 2);

    const deps = makeDeps({
      executeTrade: async (_m, u) => {
        if (u === JOINER_A) throw new Error("INSUFFICIENT_FUNDS: user vault empty");
        return "0xtx_success";
      },
    });

    const batch = (await Batch.findById("batch-partial"))!;
    const result = await executeBatch(batch, deps);

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    // Batch still EXECUTED (at least one succeeded)
    expect((await Batch.findById("batch-partial"))!.status).toBe("EXECUTED");

    const failedTrade = await Trade.findOne({ batchId: "batch-partial", userAddress: JOINER_A });
    expect(failedTrade!.status).toBe("FAILED");
    expect(failedTrade!.errorMessage).toBe("INSUFFICIENT_FUNDS");
  });

  it("marks the batch FAILED when every single trade reverts", async () => {
    await createOpenBatch("batch-all-fail");
    await joinPledge("batch-all-fail", CREATOR, 1);
    await joinPledge("batch-all-fail", JOINER_A, 2);

    const deps = makeDeps({
      executeTrade: async () => { throw new Error("QuantityBelowMinimum(...)"); },
    });

    const batch = (await Batch.findById("batch-all-fail"))!;
    const result = await executeBatch(batch, deps);

    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(2);
    expect((await Batch.findById("batch-all-fail"))!.status).toBe("FAILED");
  });

  it("handles an empty batch with no pending trades gracefully", async () => {
    await createOpenBatch("batch-empty");
    const batch = (await Batch.findById("batch-empty"))!;
    const result = await executeBatch(batch, makeDeps());

    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skippedEmpty).toBe(true);
    expect((await Batch.findById("batch-empty"))!.status).toBe("EXECUTED");
  });
});

describe("runOnce (full cycle)", () => {
  it("claims, executes, and returns the result in one call", async () => {
    await createOpenBatch("batch-runonce");
    await joinPledge("batch-runonce", CREATOR, 5);

    const { claimed, result } = await runOnce(makeDeps());

    expect(claimed).toBe(true);
    expect(result!.batchId).toBe("batch-runonce");
    expect(result!.succeeded).toBe(1);

    const batch = await Batch.findById("batch-runonce");
    expect(batch!.status).toBe("EXECUTED");
  });

  it("aborts gracefully when operator is below gas floor", async () => {
    await createOpenBatch("batch-cold-op");
    await joinPledge("batch-cold-op", CREATOR, 1);

    const deps = makeDeps({
      checkWarmup: async () => ({ ready: false, balanceSTT: 0.001 }),
    });

    const { claimed, result } = await runOnce(deps);
    expect(claimed).toBe(true);
    expect(result!.succeeded).toBe(0);
    expect((await Batch.findById("batch-cold-op"))!.status).toBe("FAILED");
  });
});

describe("normalizeError", () => {
  it("maps known on-chain reverts to constant strings", () => {
      expect(normalizeError(new Error("INSUFFICIENT_FUNDS"))).toBe("INSUFFICIENT_FUNDS");
    expect(normalizeError(new Error("gas exceeded limit, Out of gas"))).toBe("OUT_OF_GAS");
    expect(normalizeError(new Error("OnlyApprovedContracts()"))).toBe("ONLY_APPROVED_CONTRACTS");
    expect(normalizeError(new Error("QuantityBelowMinimum(5, 100)"))).toBe("QUANTITY_BELOW_MINIMUM");
  });

  it("truncates long unknown messages", () => {
    const long = "x".repeat(500);
    expect(normalizeError(new Error(long)).length).toBeLessThanOrEqual(300);
  });
});
