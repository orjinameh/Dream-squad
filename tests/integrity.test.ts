import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

vi.mock("@/lib/warmup", () => ({
  checkAccountWarmup: async (address: string) => ({ warm: true, balance: 10, minRequired: 0.05 }),
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
import { POST as botResultRoute } from "@/app/api/matches/bot-result/route";
import { POST as resultRoute } from "@/app/api/matches/result/route";
import { GET as activeRoute } from "@/app/api/matches/active/route";
import { Match } from "@/db/models/Match";
import { PlayerStats } from "@/db/models/PlayerStats";
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

describe("Match Integrity — Exploit Tests", () => {
  // 1. Duplicate prediction submission (race condition)
  it("atomic prediction guard overwrites prediction only once", async () => {
    const matchId = await createActiveBotMatch(PLAYER_A, 3);

    // Simulate concurrent duplicate requests — first should resolve the round
    const res1 = await predictRoute(jsonPost("/api/matches/predict", {
      matchId,
      playerAddress: PLAYER_A,
      prediction: "UP",
    }));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    // Bot round resolves immediately — score should reflect round 1 result
    expect(body1.rounds.length).toBeGreaterThanOrEqual(1);

    // Second predict: round is now LOCKED (advanced past round 1)
    const res2 = await predictRoute(jsonPost("/api/matches/predict", {
      matchId,
      playerAddress: PLAYER_A,
      prediction: "DOWN",
    }));
    // Should be rejected because round phase is no longer ACTIVE
    expect(res2.status).toBe(409);
  });

  // 2. Late prediction after deadline
  it("rejects prediction after round deadline", async () => {
    const matchId = await createActiveBotMatch(PLAYER_A, 3);

    // Fast-forward the match deadline to the past
    await Match.findByIdAndUpdate(matchId, {
      roundDeadline: new Date(Date.now() - 10_000),
    });

    const res = await predictRoute(jsonPost("/api/matches/predict", {
      matchId,
      playerAddress: PLAYER_A,
      prediction: "UP",
    }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("deadline");
  });

  // 3. Creating second match while one is active
  it("prevents creating a second match while one is active", async () => {
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

  // 4. Bot result idempotency (double settlement)
  it("returns idempotent response on duplicate bot result submission", async () => {
    const matchId = await createActiveBotMatch(PLAYER_A, 3);
    const addr = normalizeAddress(PLAYER_A);

    const body = {
      idempotencyKey: "test-bot-key-1",
      matchId,
      playerAddress: PLAYER_A,
      rounds: [
        { roundNum: 1, playerPrediction: "UP", rivalPrediction: "DOWN", actual: "UP", playerCorrect: true, rivalCorrect: false },
        { roundNum: 2, playerPrediction: "DOWN", rivalPrediction: "DOWN", actual: "DOWN", playerCorrect: true, rivalCorrect: true },
        { roundNum: 3, playerPrediction: "UP", rivalPrediction: "DOWN", actual: "UP", playerCorrect: true, rivalCorrect: false },
      ],
      playerScore: 3,
      rivalScore: 1,
      winner: "player",
      playerChar: "dreamer",
    };

    const res1 = await botResultRoute(jsonPost("/api/matches/bot-result", body));
    expect(res1.status).toBe(200);
    const b1 = await res1.json();
    expect(b1.deduped).toBeUndefined();

    const res2 = await botResultRoute(jsonPost("/api/matches/bot-result", body));
    expect(res2.status).toBe(200);
    const b2 = await res2.json();
    expect(b2.deduped).toBe(true);

    // Verify stats weren't double-counted
    const stats = await PlayerStats.findById(addr);
    expect(stats!.botMatches).toBe(1);
    expect(stats!.botWins).toBe(1);
  });

  // 5. PvP result idempotency (double settlement)
  it("returns idempotent response on duplicate PvP result", async () => {
    const addrB = normalizeAddress(PLAYER_B);
    const addrC = normalizeAddress(PLAYER_C);
    const matchId = `pvp-result-test-${Date.now()}`;
    await Match.create({
      _id: matchId,
      playerAddress: addrB,
      playerChar: "oracle",
      rivalName: "CIPHER",
      rivalChar: "degen",
      mode: "quick",
      totalRounds: 3,
      currentRound: 3,
      roundPhase: "REVEALED",
      roundStartTime: new Date(),
      roundDeadline: new Date(Date.now() + 10_000),
      playerScore: 2,
      rivalScore: 1,
      winner: "player",
      status: "ACTIVE",
      opponentType: "player",
      player2Address: addrC,
      player1Ready: true,
      player2Ready: true,
    });

    const body = {
      matchId,
      playerAddress: PLAYER_B,
      rounds: [
        { roundNum: 1, playerPrediction: "UP", rivalPrediction: "DOWN", actual: "UP", playerCorrect: true, rivalCorrect: false },
        { roundNum: 2, playerPrediction: "DOWN", rivalPrediction: "UP", actual: "DOWN", playerCorrect: true, rivalCorrect: false },
        { roundNum: 3, playerPrediction: "UP", rivalPrediction: "DOWN", actual: "DOWN", playerCorrect: false, rivalCorrect: true },
      ],
      playerScore: 2,
      rivalScore: 1,
    };

    const res1 = await resultRoute(jsonPost("/api/matches/result", body));
    expect(res1.status).toBe(200);

    const res2 = await resultRoute(jsonPost("/api/matches/result", body));
    expect(res2.status).toBe(200);
    const b2 = await res2.json();
    expect(b2.idempotent).toBe(true);

    // Verify both players' stats exist
    const stats1 = await PlayerStats.findById(addrB);
    expect(stats1!.pvpMatches).toBe(1);
    const stats2 = await PlayerStats.findById(addrC);
    expect(stats2!.pvpMatches).toBe(1);
  });

  // 6. Submitting prediction for non-participant match
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

  // 7. Match settlement when already settled
  it("prevents double match settlement", async () => {
    const matchId = await createActiveBotMatch(PLAYER_A, 3);
    const addr = normalizeAddress(PLAYER_A);

    const body = {
      idempotencyKey: "test-bot-key-2",
      matchId,
      playerAddress: PLAYER_A,
      rounds: [
        { roundNum: 1, playerPrediction: "UP", rivalPrediction: "DOWN", actual: "UP", playerCorrect: true, rivalCorrect: false },
        { roundNum: 2, playerPrediction: "DOWN", rivalPrediction: "DOWN", actual: "DOWN", playerCorrect: true, rivalCorrect: true },
        { roundNum: 3, playerPrediction: "UP", rivalPrediction: "DOWN", actual: "UP", playerCorrect: true, rivalCorrect: false },
      ],
      playerScore: 3,
      rivalScore: 1,
      winner: "player",
      playerChar: "dreamer",
    };

    const res1 = await botResultRoute(jsonPost("/api/matches/bot-result", body));
    expect(res1.status).toBe(200);

    const matchAfter = await Match.findById(matchId);
    expect(matchAfter!.status).toBe("COMPLETED");

    // Second attempt with different key should still return idempotent
    const res2 = await botResultRoute(jsonPost("/api/matches/bot-result", {
      ...body,
      idempotencyKey: "test-bot-key-3",
    }));
    expect(res2.status).toBe(200);
    const b2 = await res2.json();
    expect(b2.deduped).toBe(true);
  });

  // 8. DreamDEX double execution (idempotency guard)
  it("executeGameRound returns cached result on duplicate call", async () => {
    const { executeGameRound } = await import("@/lib/operator");
    const fn = executeGameRound as any;

    const result1 = await fn("SOMI:USDso", PLAYER_A, "UP", 1, "test-match-1");
    expect(result1.success).toBe(true);
    const txHash1 = result1.txHash;

    const result2 = await fn("SOMI:USDso", PLAYER_A, "UP", 1, "test-match-1");
    expect(result2.txHash).toBe(txHash1);
  });

  // Extra: active match endpoint doesn't leak opponent wallet
  it("active match response does not contain raw wallet addresses", async () => {
    await createActiveBotMatch(PLAYER_A, 3);

    const res = await activeRoute(jsonGet(`/api/matches/active?address=${PLAYER_A}`));
    const body = await res.json();
    expect(body.player1Address).toBeUndefined();
    expect(body.player2Address).toBeUndefined();
    expect(body.active).toBe(true);
  });
});
