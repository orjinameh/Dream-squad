import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

// Funding gate reads live chain allowance — bypass in unit tests (no RPC).
vi.mock("@/lib/ec/funding", () => ({
  matchPotRaw: (a: number, r: number) => BigInt(Math.round(a * 1_000_000)) * BigInt(r),
  assertMatchFunding: vi.fn(async () => ({ ok: true })),
}));

import { POST as roomRoute } from "@/app/api/matchmaking/room/route";
import { GET as statusRoute } from "@/app/api/matchmaking/status/route";
import { POST as joinRoute } from "@/app/api/matchmaking/join/route";
import { Match } from "@/db/models/Match";
import { MatchRoom } from "@/db/models/MatchRoom";
import { MatchQueue } from "@/db/models/MatchQueue";
import { EcPosition } from "@/db/models/EcPosition";

let mongo: MongoMemoryServer;

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  await Match.deleteMany({});
  await MatchQueue.deleteMany({});
  await MatchRoom.deleteMany({});
  await EcPosition.deleteMany({});
  for (const addr of [A, B, C]) {
    await EcPosition.create({
      address: addr.toLowerCase(),
      direction: "UP",
      market: "BTC",
      amount: 10,
      status: "ACTIVE",
      windowId: `0x${addr.slice(2).toLowerCase()}000000000000000000000000000000000000000000`,
      windowOpenAt: new Date(),
      windowCloseAt: new Date(Date.now() + 15 * 60 * 1000),
      settledOnchain: false,
      matchCount: 0,
    });
  }
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

async function createRoom(address: string, rounds = 7, amountPerRound = 7) {
  const res = await roomRoute(jsonPost("/api/matchmaking/room", { address, rounds, charId: "dreamer", amountPerRound }));
  return { status: res.status, body: await res.json() };
}

describe("Private rooms (invite codes)", () => {
  it("mints a DUEL-XXXX code the host can poll as waiting", async () => {
    const { status, body } = await createRoom(A);
    expect(status).toBe(201);
    expect(body.status).toBe("waiting");
    expect(body.code).toMatch(/^DUEL-[A-Z2-9]{4}$/);

    const st = await statusRoute(jsonGet(`/api/matchmaking/status?code=${body.code}`));
    expect(st.status).toBe(200);
    const sBody = await st.json();
    expect(sBody.status).toBe("waiting");
    expect(sBody.matchId).toBeNull();
  });

  it("pairs guest + host into one ACTIVE PvP match on code join", async () => {
    const { body: created } = await createRoom(A);
    const res = await joinRoute(jsonPost("/api/matchmaking/join", {
      address: B, code: created.code, charId: "oracle", amountPerRound: 7,
    }));
    expect(res.status).toBe(200);
    const joined = await res.json();
    expect(joined.status).toBe("matched");
    expect(joined.matchId).toBeTruthy();

    // Host poll breaks with the same matchId — zero-latency handoff for both ends.
    const st = await statusRoute(jsonGet(`/api/matchmaking/status?code=${created.code}`));
    const sBody = await st.json();
    expect(sBody.status).toBe("matched");
    expect(sBody.matchId).toBe(joined.matchId);

    const match = await Match.findById(joined.matchId).lean();
    expect(match).toBeTruthy();
    expect(match!.status).toBe("ACTIVE");
    expect(match!.opponentType).toBe("player");
    expect([match!.playerAddress, match!.player2Address]).toContain(A.toLowerCase());
    expect([match!.playerAddress, match!.player2Address]).toContain(B.toLowerCase());
    expect(match!.playerAmountPerRound).toBe(7);
  });

  it("is idempotent for both parties; rejects a third wallet and self-join", async () => {
    const { body: created } = await createRoom(A);
    const first = await (await joinRoute(jsonPost("/api/matchmaking/join", { address: B, code: created.code }))).json();
    expect(first.status).toBe("matched");

    // Guest rejoins → same match, no duplicate.
    const again = await (await joinRoute(jsonPost("/api/matchmaking/join", { address: B, code: created.code }))).json();
    expect(again.status).toBe("matched");
    expect(again.matchId).toBe(first.matchId);
    expect(await Match.countDocuments({})).toBe(1);

    // Host rejoins its own matched room → same match.
    const hostAgain = await (await joinRoute(jsonPost("/api/matchmaking/join", { address: A, code: created.code }))).json();
    expect(hostAgain.matchId).toBe(first.matchId);

    // Stranger on a used code → gone.
    const stranger = await joinRoute(jsonPost("/api/matchmaking/join", { address: C, code: created.code }));
    expect(stranger.status).toBe(410);
  });

  it("rejects self-join on a waiting room, unknown and malformed codes", async () => {
    const { body: created } = await createRoom(A);
    const self = await joinRoute(jsonPost("/api/matchmaking/join", { address: A, code: created.code }));
    expect(self.status).toBe(400);

    const unknown = await joinRoute(jsonPost("/api/matchmaking/join", { address: B, code: "DUEL-ZZ99" }));
    expect(unknown.status).toBe(404);

    const malformed = await joinRoute(jsonPost("/api/matchmaking/join", { address: B, code: "abc" }));
    expect(malformed.status).toBe(400);

    const stBad = await statusRoute(jsonGet("/api/matchmaking/status?code=nope"));
    expect(stBad.status).toBe(400);
  });

  it("expires rooms: join and status both report gone", async () => {
    const { body: created } = await createRoom(A);
    await MatchRoom.updateOne({ code: created.code }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await joinRoute(jsonPost("/api/matchmaking/join", { address: B, code: created.code }));
    expect(res.status).toBe(410);
    const st = await statusRoute(jsonGet(`/api/matchmaking/status?code=${created.code}`));
    expect(st.status).toBe(410);
  });

  it("requires the guest to hold a funded position", async () => {
    const { body: created } = await createRoom(A);
    await EcPosition.deleteMany({ address: B.toLowerCase() });
    const res = await joinRoute(jsonPost("/api/matchmaking/join", { address: B, code: created.code }));
    expect(res.status).toBe(409);
  });

  it("requires the host to still hold a funded position at join time", async () => {
    const { body: created } = await createRoom(A);
    await EcPosition.deleteMany({ address: A.toLowerCase() });
    const res = await joinRoute(jsonPost("/api/matchmaking/join", { address: B, code: created.code }));
    expect(res.status).toBe(409);
    const payload = await res.json();
    expect(payload.error).toContain("host funding lapsed");
  });
});
