import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

vi.mock("@/lib/warmup", () => ({
  checkAccountWarmup: async () => ({ warm: true, balance: 10, minRequired: 0.05 }),
}));

vi.mock("@/lib/operator", () => ({
  executeGameRound: vi.fn(async () => ({
    success: true,
    txHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    blockNumber: 1000n,
    blockHash: "0xhash",
    gasUsed: 21000n,
    direction: "BUY",
    amount: 1,
    marketSymbol: "SOMI:USDso",
    roundOutcome: "UP" as const,
  })),
  deriveRoundOutcome: vi.fn(() => "UP" as const),
  checkPlayerDelegation: vi.fn(async () => true),
  ensurePlayerVault: vi.fn(async () => ({ funded: true, vaultTxHash: null })),
}));

import { POST as createRoute } from "@/app/api/matches/create/route";
import { POST as predictRoute } from "@/app/api/matches/predict/route";
import { GET as stateRoute } from "@/app/api/matches/state/route";
import { GET as leaderboardRoute } from "@/app/api/leaderboard/route";
import { Match } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { generateMatchPriceModel } from "@/lib/prices";

let mongo: MongoMemoryServer;
const PLAYER = "0x9196d7670eea0CB723af11465d4285541a2eA86a";

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

function jsonPost(url: string, body: unknown): Request {
  return new Request(`http://test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function jsonGet(url: string): Request {
  return new Request(`http://test${url}`);
}

describe("POST /api/matches/create", () => {
  it("creates a bot match and returns match info", async () => {
    const res = await createRoute(jsonPost("/api/matches/create", {
      playerAddress: PLAYER,
      playerChar: "dreamer",
      rivalName: "BOT",
      rivalChar: "oracle",
      mode: "quick",
      totalRounds: 3,
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.matchId).toBeTruthy();
    expect(body.roundStartTime).toBeTruthy();
    expect(body.roundDeadline).toBeTruthy();
  });

  it("rejects duplicate active matches for same wallet", async () => {
    await createRoute(jsonPost("/api/matches/create", {
      playerAddress: PLAYER,
      playerChar: "dreamer",
      rivalName: "BOT",
      rivalChar: "oracle",
      mode: "quick",
      totalRounds: 3,
    }));
    const res = await createRoute(jsonPost("/api/matches/create", {
      playerAddress: PLAYER,
      playerChar: "dreamer",
      rivalName: "BOT2",
      rivalChar: "oracle",
      mode: "quick",
      totalRounds: 3,
    }));
    expect(res.status).toBe(409);
  });
});

describe("POST /api/matches/predict", () => {
  it("resolves a round against the continuous price model and returns state", async () => {
    const matchId = `test-predict-${Date.now()}`;
    const addr = normalizeAddress(PLAYER);
    const priceModel = generateMatchPriceModel(matchId, "BTC", 3);
    await Match.create({
      _id: matchId,
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
      predictionAsset: "BTC",
      priceModel,
    });

    const res = await predictRoute(jsonPost("/api/matches/predict", {
      matchId,
      playerAddress: PLAYER,
      prediction: "UP",
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rounds.length).toBe(1);
    expect(body.rounds[0].actual).toBeTruthy();
    // The round's outcome must match the precomputed checkpoint for round 1.
    expect(body.rounds[0].actual).toBe(priceModel.checkpoints[0].actual);
  });
});

describe("GET /api/matches/state", () => {
  it("returns match state for active match", async () => {
    const matchId = `test-state-${Date.now()}`;
    const addr = normalizeAddress(PLAYER);
    await Match.create({
      _id: matchId,
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
    });

    const res = await stateRoute(jsonGet(`/api/matches/state?matchId=${matchId}&address=${PLAYER}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matchId).toBe(matchId);
    expect(body.status).toBe("ACTIVE");
  });
});

describe("GET /api/leaderboard", () => {
  it("returns leaderboard data", async () => {
    const res = await leaderboardRoute(jsonGet("/api/leaderboard?limit=10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.leaderboard)).toBe(true);
  });
});
