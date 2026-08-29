import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { POST as joinRoute } from "@/app/api/matchmaking/join/route";
import { POST as leaveRoute } from "@/app/api/matchmaking/leave/route";
import { GET as statusRoute } from "@/app/api/matchmaking/status/route";
import { Match } from "@/db/models/Match";
import { MatchQueue } from "@/db/models/MatchQueue";

let mongo: MongoMemoryServer;

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

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
});
