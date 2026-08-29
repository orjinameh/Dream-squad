import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { POST as joinRoute } from "@/app/api/matchmaking/join/route";
import { POST as leaveRoute } from "@/app/api/matchmaking/leave/route";
import { POST as clearRoute } from "@/app/api/matchmaking/clear/route";
import { GET as statusRoute } from "@/app/api/matchmaking/status/route";
import { Match } from "@/db/models/Match";
import { MatchQueue } from "@/db/models/MatchQueue";

let mongo: MongoMemoryServer;

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

// Real-world EIP-55 mixed-case (checksummed) wallet addresses — distinct from
// the all-lowercase A/B above. Regression guard for the queue `lowercase: true`
// vs `normalizeAddress` checksum inconsistency that made /status and /join
// miss searching queue entries for normal (mixed-case) wallets.
const CA = "0x52908400098527886E0F7030069857D2E4169EE7";
const CB = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  await Match.deleteMany({});
  await MatchQueue.deleteMany({});
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

async function join(address: string, rounds = 7) {
  const res = await joinRoute(jsonPost("/api/matchmaking/join", { address, rounds, charId: "dreamer" }));
  return res.json();
}

async function status(address: string) {
  const res = await statusRoute(jsonGet(`/api/matchmaking/status?address=${address}`));
  return res.json();
}

describe("PvP matchmaking (two devices)", () => {
  it("pairs a second joiner with the first and creates an active match both can see", async () => {
    // First device joins and stays searching with no rival yet.
    const rA = await join(A);
    expect(rA.status).toBe("searching");

    // Second device joins and should match against A.
    const rB = await join(B);
    expect(rB.status).toBe("matched");
    expect(rB.matchId).toBeTruthy();

    // Both devices must be able to see the created match via /status.
    const sA = await status(A);
    const sB = await status(B);
    expect(sA.status).toBe("matched");
    expect(sA.matchId).toBe(rB.matchId);
    expect(sB.status).toBe("matched");
    expect(sB.matchId).toBe(rB.matchId);

    // The match exists, is ACTIVE, and both addresses are players in it.
    const match = await Match.findById(rB.matchId).lean();
    expect(match).toBeTruthy();
    expect(match!.status).toBe("ACTIVE");
    expect([match!.playerAddress, match!.player2Address]).toContain(A.toLowerCase());
    expect([match!.playerAddress, match!.player2Address]).toContain(B.toLowerCase());

    // Queue entries should no longer be "searching".
    const stillSearching = await MatchQueue.countDocuments({ status: "searching" });
    expect(stillSearching).toBe(0);
  });

  it("cleans up the queue on leave so a stale entry never blocks a future pairing", async () => {
    // Join, then leave, then join again — must still match a fresh opponent.
    await join(A);
    await leaveRoute(jsonPost("/api/matchmaking/leave", { address: A }));
    const rA2 = await join(A);
    expect(rA2.status).toBe("searching");

    await join(B);
    const rB2 = await join(B); // idempotent — B already searching, may match A
    const sA = await status(A);
    expect(sA.status).toBe("matched");
    expect(sA.matchId).toBeTruthy();
    expect(rB2.status).toMatch(/matched|searching/);
  });

  it("expires an abandoned WAITING match so it never hijacks a real pairing", async () => {
    // Simulate a previous abandoned PvP match still stuck in WAITING for B —
    // the exact state that previously made the active-match guard return
    // "matched" to a dead match and prevented a real pairing.
    await Match.create({
      _id: "stale-waiting",
      playerAddress: B,
      player2Address: "0x3333333333333333333333333333333333333333",
      playerChar: "dreamer",
      rivalChar: "dreamer",
      rivalName: "STALE",
      mode: "battle",
      opponentType: "player",
      status: "ACTIVE",
      roundPhase: "WAITING",
      roundDeadline: new Date(Date.now() - 60_000),
      player1Ready: false,
      player2Ready: false,
      totalRounds: 7,
      currentRound: 1,
      playerScore: 0,
      rivalScore: 0,
      winner: "player",
      rounds: [],
      playerPrediction: null,
      rivalPrediction: null,
    });

    // B joins — the stale WAITING match must be expired, so B can queue.
    const rB = await join(B);
    expect(rB.status).toBe("searching");

    // A joins and must pair with B (not be routed to a stale match).
    const rA = await join(A);
    expect(rA.status).toBe("matched");
    expect(rA.matchId).toBeTruthy();

    // The stale match is no longer ACTIVE.
    const stale = await Match.findById("stale-waiting").lean();
    expect(stale!.status).toBe("COMPLETED");
  });

  it("treats mixed-case (checksummed) wallets the same as lowercase ones", async () => {
    // First device (checksummed) joins and stays searching.
    const rA = await join(CA);
    expect(rA.status).toBe("searching");

    // Second device (checksummed) joins and should match against CA.
    const rB = await join(CB);
    expect(rB.status).toBe("matched");

    // Both devices must see the same match via /status (this is where the
    // lowercase/checksum mismatch used to break the queue lookup).
    const sA = await status(CA);
    const sB = await status(CB);
    expect(sA.status).toBe("matched");
    expect(sA.matchId).toBe(rB.matchId);
    expect(sB.status).toBe("matched");
    expect(sB.matchId).toBe(rB.matchId);
  });

  it("abandons a WAITING match on leave so re-joining can't phantom re-pair", async () => {
    // Reproduce the "both went home, then re-paired with each other" bug:
    // a player leaves but their ACTIVE/WAITING match survives, so a later join
    // gets routed back into the old match instead of a fresh pairing.
    await Match.create({
      _id: "left-match",
      playerAddress: A,
      player2Address: B,
      playerChar: "dreamer",
      rivalChar: "dreamer",
      rivalName: "STALE",
      mode: "battle",
      opponentType: "player",
      status: "ACTIVE",
      roundPhase: "WAITING",
      roundDeadline: new Date(Date.now() + 20_000),
      player1Ready: true,
      player2Ready: false,
      totalRounds: 7,
      currentRound: 1,
      playerScore: 0,
      rivalScore: 0,
      winner: "player",
      rounds: [],
      playerPrediction: null,
      rivalPrediction: null,
    });

    // Both players leave (go home).
    await leaveRoute(jsonPost("/api/matchmaking/leave", { address: A }));
    await leaveRoute(jsonPost("/api/matchmaking/leave", { address: B }));

    const abandoned = await Match.findById("left-match").lean();
    expect(abandoned!.status).toBe("COMPLETED");

    // Re-join — must start fresh in the queue, not be routed to the old match.
    const rB = await join(B);
    expect(rB.status).toBe("searching");
    const rA = await join(A);
    expect(rA.status).toBe("matched");
    expect(rA.matchId).not.toBe("left-match");
  });

  it("clear wipes stale queue entries and abandoned WAITING PvP matches", async () => {
    // Simulate a leftover phantom: a searching queue entry whose owner is gone,
    // plus an abandoned ACTIVE/WAITING PvP match.
    await MatchQueue.create({ _id: "phantom-q", address: A, rounds: 7, charId: "dreamer", status: "searching" });
    await Match.create({
      _id: "phantom-match",
      playerAddress: A,
      player2Address: B,
      playerChar: "dreamer",
      rivalChar: "dreamer",
      rivalName: "PHANTOM",
      mode: "battle",
      opponentType: "player",
      status: "ACTIVE",
      roundPhase: "WAITING",
      roundDeadline: new Date(Date.now() + 60_000),
      player1Ready: false,
      player2Ready: false,
      totalRounds: 7,
      currentRound: 1,
      playerScore: 0,
      rivalScore: 0,
      winner: "player",
      rounds: [],
      playerPrediction: null,
      rivalPrediction: null,
    });

    const res = await clearRoute();
    const data = await res.json();
    expect(data.cleared).toBe(true);

    // Queue is empty, so a fresh join has no phantom to match against.
    expect(await MatchQueue.countDocuments({})).toBe(0);
    const phantom = await Match.findById("phantom-match").lean();
    expect(phantom!.status).toBe("COMPLETED");
  });
});
