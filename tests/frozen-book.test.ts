import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
process.env.DREAMDUEL_FAST_ROUNDS = "1"; // fast tests: skip the 10s ACTIVE hold
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

vi.mock("@/lib/warmup", () => ({
  checkAccountWarmup: async () => ({ warm: true, balance: 10, minRequired: 0.05 }),
}));

vi.mock("@/lib/operator", () => ({
  executeGameRound: vi.fn(async () => ({ success: true })),
  deriveRoundOutcome: vi.fn(() => "UP" as const),
  checkPlayerDelegation: vi.fn(async () => true),
  ensurePlayerVault: vi.fn(async () => ({ funded: true, vaultTxHash: null })),
}));

// Frozen EC book: the YES-mid never moves between the Second-5 entry and the
// Second-15 exit. EC-only judge => every round is an honest FLAT draw (a push:
// 0 PnL, balances untouched), never a fabricated UP/DOWN.
const FROZEN_MID = 0.30;

vi.mock("@/lib/ec/executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ec/executor")>();
  return {
    ...actual,
    readArenaPrice: vi.fn(async () => ({
      yesPrice: FROZEN_MID,
      bestBid: FROZEN_MID - 0.014,
      bestAsk: FROZEN_MID + 0.014,
      updatedMs: Date.now(),
    })),
  };
});

const FAKE_ARENA = {
  symbol: "BTC-FROZEN-01JAN30-0000/tUSDC",
  marketId: "0xfrozen",
  pool: "0x0000000000000000000000000000000000000002",
  collateral: "0x0000000000000000000000000000000000000003",
  token: "0x0000000000000000000000000000000000000004",
  yesId: 1n,
  noId: 2n,
  strike: "78000",
  decimals: 6,
  expiry: Math.floor(Date.now() / 1000) + 600,
};

vi.mock("@/lib/ec/arena", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ec/arena")>();
  return {
    ...actual,
    ecArenaForMatch: vi.fn(async () => FAKE_ARENA),
    ecArenaForRound: vi.fn(async () => FAKE_ARENA),
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

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("Frozen EC book (EC-only judge)", () => {
  it("resolves every round FLAT as a push: 0 PnL, balances untouched", async () => {
    const addr = normalizeAddress(PLAYER).toLowerCase();
    await Match.deleteMany({ playerAddress: addr });
    const priceModel = buildMatchPriceModel("BTC", 78000);
    const doc = await Match.create({
      _id: `test-frozen-${Date.now()}`,
      playerAddress: addr,
      playerChar: "dreamer",
      rivalName: "BOT",
      rivalChar: "oracle",
      mode: "quick",
      totalRounds: 3,
      currentRound: 1,
      roundPhase: "ACTIVE",
      roundStartTime: new Date(),
      roundDeadline: new Date(Date.now() + 60_000),
      status: "ACTIVE",
      opponentType: "bot",
      funded: true,
      predictionAsset: "BTC",
      playerStartBalance: 100,
      playerBalance: 100,
      rivalStartBalance: 100,
      rivalBalance: 100,
      priceModel,
    });
    const matchId = doc._id;

    // Round 1 resolves from the seeded ACTIVE (no entry — FLAT); each later
    // round passes COMMIT (entry pinned at the frozen mid) then ACTIVE.
    let body: any;
    for (let i = 0; i < 5; i++) {
      const res = await predictRoute(jsonPost("/api/matches/predict", {
        matchId,
        playerAddress: PLAYER,
        prediction: "UP",
      }));
      expect(res.status).toBe(200);
      body = await res.json();
      if (body.status === "COMPLETED") break;
    }

    expect(body.status).toBe("COMPLETED");
    expect(body.rounds.length).toBe(3);
    for (const round of body.rounds) {
      expect(round.actual).toBe("FLAT");
      expect(round.playerPnL).toBe(0);
      expect(round.rivalPnL).toBe(0);
    }
    // Push economics: the book never moved, so no money moved either.
    expect(body.playerBalance).toBe(100);
    expect(body.rivalBalance).toBe(100);
    expect(body.winner).toBe("draw");
  });
});
