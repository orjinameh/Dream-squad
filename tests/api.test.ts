import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { EcPosition } from "@/db/models/EcPosition";
import { normalizeAddress } from "@/lib/addresses";
import { buildMatchPriceModel } from "@/lib/prices";

let mongo: MongoMemoryServer;
const PLAYER = "0x9196d7670eea0CB723af11465d4285541a2eA86a";

async function seedActivePosition(player: string, amount = 10): Promise<string> {
  const doc = await EcPosition.create({
    address: normalizeAddress(player).toLowerCase(),
    direction: "UP",
    market: "BTC",
    amount,
    status: "ACTIVE",
    windowId: `test-round-${player}-${Date.now()}`,
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
  beforeEach(async () => {
    await Match.deleteMany({ $or: [{ playerAddress: normalizeAddress(PLAYER).toLowerCase() }, { player2Address: normalizeAddress(PLAYER).toLowerCase() }] });
    await EcPosition.deleteMany({ address: normalizeAddress(PLAYER).toLowerCase() });
  });

  it("creates a bot match and returns match info", async () => {
    await seedActivePosition(PLAYER);
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
    await seedActivePosition(PLAYER);
    // First create succeeds and leaves an active match.
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
    const body = await res.json();
    expect(body.error).toContain("already in an active match");
  });
});

describe("POST /api/matches/predict", () => {
  it("resolves a round from the REAL price model; no-op FLAT when the feed can't resolve", async () => {
    const matchId = `test-predict-${Date.now()}`;
    const addr = normalizeAddress(PLAYER);
    const priceModel = buildMatchPriceModel("BTC", 78147);
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
    // A bot match resolves against the real EC YES oracle whenever a live
    // BTC arena window exists, else records an honest no-op FLAT draw. Either
    // way the recorded round must be internally consistent — never fabricated.
    const round = body.rounds[0];
    expect(["UP", "DOWN", "FLAT"]).toContain(round.actual);
    const pred = round.playerPrediction;
    if (round.actual === "FLAT") {
      expect(round.playerCorrect).toBe(false);
    } else {
      expect(round.playerCorrect).toBe(pred === round.actual);
    }
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
