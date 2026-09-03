import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

vi.mock("@/lib/warmup", () => ({
  checkAccountWarmup: async () => ({ warm: true, balance: 10, minRequired: 0.05 }),
}));

vi.mock("@/lib/operator", () => ({
  executeGameRound: vi.fn(async () => ({ success: true, txHash: "0x1234", blockNumber: 1000n, blockHash: "0xhash", gasUsed: 21000n, direction: "BUY", amount: 1, marketSymbol: "SOMI:USDso", roundOutcome: "UP" as const })),
  deriveRoundOutcome: vi.fn(() => "UP" as const),
  checkPlayerDelegation: vi.fn(async () => true),
  ensurePlayerVault: vi.fn(async () => ({ funded: true, vaultTxHash: null })),
}));

// Scripted EC oracle: a fake arena whose YES mid advances monotonically in
// small steps (~0.006-0.008/tick, the real magnitude measured on the live book).
// This simulates the user's scenario where the mid IS moving but rounds must
// still resolve directionally instead of collapsing to a 0-0 draw.
let midIndex = -1;
const mids = [0.30, 0.306, 0.313, 0.319, 0.326, 0.332, 0.339, 0.345, 0.352, 0.358];

vi.mock("@/lib/ec/executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ec/executor")>();
  return {
    ...actual,
    readArenaPrice: vi.fn(async () => {
      midIndex += 1;
      const yesPrice = mids[Math.min(midIndex, mids.length - 1)];
      // Real EC spread is wide (~0.028, half = 0.014) relative to the raw per-round
      // mid tick (~0.007). So rawDiff lies UNDER the spread band and would resolve
      // FLAT without leverage — exactly the user's all-FLAT 0-0 bug. Leverage must
      // amplify rawDiff past the band to resolve directionally.
      const halfSpread = 0.014;
      return { yesPrice, bestBid: yesPrice - halfSpread, bestAsk: yesPrice + halfSpread, updatedMs: Date.now() };
    }),
  };
});

vi.mock("@/lib/ec/arena", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ec/arena")>();
  return {
    ...actual,
    ecArenaForMatch: vi.fn(async () => ({
      symbol: "BTC-12345-03SEP26-0000/tUSDC",
      marketId: "0x1",
      pool: "0x2",
      collateral: "0x3",
      token: "0x4",
      yesId: 1n,
      noId: 2n,
      strike: "78000",
      decimals: 6,
      expiry: Math.floor(Date.now() / 1000) + 600,
    })),
  };
});

import { POST as predictRoute } from "@/app/api/matches/predict/route";
import { Match } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { buildMatchPriceModel } from "@/lib/prices";

let mongo: MongoMemoryServer;
const PLAYER = "0x9196d7670eea0CB723af11465d4285541a2eA86a";

function jsonPost(url: string, body: unknown): Request {
  return new Request(`http://test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedMatch(totalRounds = 5): Promise<string> {
  const addr = normalizeAddress(PLAYER).toLowerCase();
  await Match.deleteMany({ playerAddress: addr });
  const priceModel = buildMatchPriceModel("BTC", 78000);
  (priceModel as unknown as { arenaOpen?: number }).arenaOpen = mids[0];
  const doc = await Match.create({
    _id: `test-res-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    playerAddress: addr,
    playerChar: "dreamer",
    rivalName: "BOT",
    rivalChar: "oracle",
    mode: "quick",
    totalRounds,
    currentRound: 1,
    roundPhase: "ACTIVE",
    roundStartTime: new Date(),
    roundDeadline: new Date(Date.now() + 60_000),
    status: "ACTIVE",
    opponentType: "bot",
    funded: true,
    predictionAsset: "BTC",
    priceModel,
  });
  return doc._id;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(() => {
  midIndex = -1;
});

describe("Round resolution leverage (all-FLAT regression)", () => {
  it("resolves a moving EC mid to UP/DOWN, not a perpetual 0-0 draw", async () => {
    const matchId = await seedMatch(5);
    const observed: string[] = [];

    let body: any;
    for (let r = 1; r <= 5; r++) {
      const res = await predictRoute(jsonPost("/api/matches/predict", {
        matchId,
        playerAddress: PLAYER,
        prediction: "UP",
      }));
      expect(res.status).toBe(200);
      body = await res.json();
      for (const round of body.rounds ?? []) {
        const roundNum = Number(round.roundNum);
        if (!observed[roundNum]) observed[roundNum] = round.actual;
      }
    }

    const resolved = observed.filter(Boolean);
    // The user's bug: every round resolves FLAT (0-0) even though the mid moves.
    // With a monotonically-moving mid, at least one (really most) rounds MUST
    // resolve directionally. All-FLAT here means the leverage/banding regressed.
    const nonFlat = resolved.filter((a) => a !== "FLAT");
    expect(resolved.length).toBeGreaterThan(0);
    expect(nonFlat.length).toBeGreaterThan(0);
  });
});
