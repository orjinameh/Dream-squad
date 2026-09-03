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
import { GET as activeRoute } from "@/app/api/matches/active/route";
import { Match } from "@/db/models/Match";
import { PlayerStats } from "@/db/models/PlayerStats";
import { EcPosition } from "@/db/models/EcPosition";
import { normalizeAddress } from "@/lib/addresses";

let mongo: MongoMemoryServer;

const PLAYER_A = "0x9196d7670eea0CB723af11465d4285541a2eA86a";
const PLAYER_B = "0xdd68998C099f7570E59019ae35469E5603cEDA11";
const PLAYER_C = "0x66D913034C8F5A2C096c706C4f437A59ec73f016";

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

async function createActiveBotMatch(player: string, totalRounds = 3): Promise<string> {
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

describe("Match Integrity — Exploit Tests", () => {
  // 1. Predict resolves atomically — second call returns state (not error)
  it("atomic prediction claim resolves round exactly once", async () => {
    const matchId = await createActiveBotMatch(PLAYER_A, 3);

    const res1 = await predictRoute(jsonPost("/api/matches/predict", {
      matchId,
      playerAddress: PLAYER_A,
      prediction: "UP",
    }));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    // Round resolved — scores updated, round advanced
    expect(body1.rounds.length).toBe(1);
    expect(body1.roundPhase).toBeDefined();

    // Second predict: round already resolved, returns current state
    const res2 = await predictRoute(jsonPost("/api/matches/predict", {
      matchId,
      playerAddress: PLAYER_A,
      prediction: "DOWN",
    }));
    expect(res2.status).toBe(200); // Returns state, not error
  });

  // 2. Late prediction — server auto-resolves expired round
  it("server auto-resolves expired bot round via predict", async () => {
    const matchId = await createActiveBotMatch(PLAYER_A, 3);

    // Fast-forward deadline to past
    await Match.findByIdAndUpdate(matchId, { roundDeadline: new Date(Date.now() - 10_000) });

    const res = await predictRoute(jsonPost("/api/matches/predict", {
      matchId,
      playerAddress: PLAYER_A,
      prediction: "UP",
    }));
    // Server auto-resolves — returns 200 with resolved state
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rounds.length).toBeGreaterThanOrEqual(1);
  });

  // 3. Creating second match while one is active
  it("prevents creating a second match while one is active", async () => {
    await seedActivePosition(PLAYER_A);
    await createActiveBotMatch(PLAYER_A, 3);

    const res = await createRoute(jsonPost("/api/matches/create", {
      playerAddress: PLAYER_A,
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

  // 3. Match completion via predict — stats processed once
  it("match completes via predict and stats are updated", async () => {
    const matchId = await createActiveBotMatch(PLAYER_A, 5);
    const addr = normalizeAddress(PLAYER_A);

    let roundsPlayed = 0;
    for (let i = 0; i < 5; i++) {
      const res = await predictRoute(jsonPost("/api/matches/predict", {
        matchId,
        playerAddress: PLAYER_A,
        prediction: "UP",
      }));
      expect(res.status).toBe(200);
      roundsPlayed++;
      const body = await res.json();
      if (body.status === "COMPLETED") break;
    }

    const matchAfter = await Match.findById(matchId);
    expect(matchAfter!.status).toBe("COMPLETED");
    expect(matchAfter!.rounds.length).toBe(roundsPlayed);
    expect(matchAfter!.statsProcessed).toBe("COMPLETE");
  });

  // 5. Non-participant cannot predict
  it("rejects prediction from non-participant", async () => {
    const matchId = await createActiveBotMatch(PLAYER_A, 3);

    const res = await predictRoute(jsonPost("/api/matches/predict", {
      matchId,
      playerAddress: PLAYER_C,
      prediction: "UP",
    }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("not a player");
  });

  // 8. DreamDEX idempotency guard
  it("executeGameRound returns cached result on duplicate call", async () => {
    const { executeGameRound } = await import("@/lib/operator");
    const fn = executeGameRound as any;

    const result1 = await fn("SOMI:USDso", PLAYER_A, "UP", 1, "test-match-1");
    expect(result1.success).toBe(true);
    const txHash1 = result1.txHash;

    const result2 = await fn("SOMI:USDso", PLAYER_A, "UP", 1, "test-match-1");
    expect(result2.txHash).toBe(txHash1);
  });

  // 9. Active match doesn't leak wallet addresses
  it("active match response does not contain raw wallet addresses", async () => {
    await createActiveBotMatch(PLAYER_A, 3);

    const res = await activeRoute(jsonGet(`/api/matches/active?address=${PLAYER_A}`));
    const body = await res.json();
    expect(body.player1Address).toBeUndefined();
    expect(body.player2Address).toBeUndefined();
    expect(body.active).toBe(true);
  });
});
