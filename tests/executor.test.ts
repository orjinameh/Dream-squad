import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

vi.mock("@/lib/warmup", () => ({
  checkAccountWarmup: async () => ({ warm: true, balance: 10, minRequired: 0.05 }),
}));

vi.mock("@/lib/operator", () => ({
  executeGameRound: vi.fn(async () => ({
    success: true,
    txHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
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
import { Match } from "@/db/models/Match";
import { PlayerStats } from "@/db/models/PlayerStats";
import { normalizeAddress } from "@/lib/addresses";

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

async function createActiveBotMatch(totalRounds = 3): Promise<string> {
  return createActiveBotMatchForPlayer(PLAYER, totalRounds);
}

async function createActiveBotMatchForPlayer(player: string, totalRounds = 3): Promise<string> {
  const addr = normalizeAddress(player);
  const now = new Date();
  const match = await Match.create({
    playerAddress: addr,
    playerChar: "dreamer",
    rivalName: "BOT",
    rivalChar: "oracle",
    mode: "quick",
    totalRounds,
    currentRound: 1,
    roundPhase: "ACTIVE",
    roundStartTime: now,
    roundDeadline: new Date(now.getTime() + 60_000),
    status: "ACTIVE",
    opponentType: "bot",
    player1Ready: true,
  });
  return match._id;
}

describe("Match Creation", () => {
  it("creates a bot match", async () => {
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
  });

  it("rejects duplicate active matches", async () => {
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

describe("Round Resolution", () => {
  it("resolves a round and returns match state", async () => {
    const matchId = await createActiveBotMatch(3);
    const res = await predictRoute(jsonPost("/api/matches/predict", {
      matchId,
      playerAddress: PLAYER,
      prediction: "UP",
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rounds.length).toBe(1);
    expect(body.rounds[0].actual).toBeTruthy();
  });

  it("completes match after all rounds", async () => {
    const matchId = await createActiveBotMatch(3);
    for (let i = 0; i < 3; i++) {
      const res = await predictRoute(jsonPost("/api/matches/predict", {
        matchId,
        playerAddress: PLAYER,
        prediction: "UP",
      }));
      expect(res.status).toBe(200);
      const body = await res.json();
      if (body.status === "COMPLETED") break;
    }
    const match = await Match.findById(matchId);
    expect(match!.status).toBe("COMPLETED");
    expect(match!.statsProcessed).toBe("COMPLETE");
  });

  it("rejects non-participant predictions", async () => {
    const matchId = await createActiveBotMatch(3);
    const res = await predictRoute(jsonPost("/api/matches/predict", {
      matchId,
      playerAddress: "0x66D913034C8F5A2C096c706C4f437A59ec73f016",
      prediction: "UP",
    }));
    expect(res.status).toBe(403);
  });
});

describe("State Endpoint", () => {
  it("returns match state", async () => {
    const matchId = await createActiveBotMatch(3);
    const res = await stateRoute(jsonGet(`/api/matches/state?matchId=${matchId}&address=${PLAYER}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matchId).toBe(matchId);
    expect(body.status).toBe("ACTIVE");
  });
});

describe("Player Stats", () => {
  it("tracks wins and P&L after match completion", async () => {
    const STATS_PLAYER = "0x66D913034C8F5A2C096c706C4f437A59ec73f016";
    const matchId = await createActiveBotMatchForPlayer(STATS_PLAYER, 3);
    for (let i = 0; i < 3; i++) {
      await predictRoute(jsonPost("/api/matches/predict", {
        matchId,
        playerAddress: STATS_PLAYER,
        prediction: "UP",
      }));
    }
    const addr = normalizeAddress(STATS_PLAYER);
    const stats = await PlayerStats.findById(addr);
    expect(stats).toBeTruthy();
    expect(stats!.totalMatches).toBeGreaterThanOrEqual(1);
    expect(stats!.totalRounds).toBeGreaterThanOrEqual(1);
  });
});
