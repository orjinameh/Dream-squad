import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

// Keep tests hermetic: never hit the live RPC for warmup checks.
vi.mock("@/lib/warmup", () => ({
  checkAccountWarmup: async (address: string) => ({ warm: address.length > 0, balance: 1, minRequired: 0.05 }),
}));

import { POST as createRoute } from "@/app/api/syndicates/create/route";
import { POST as joinRoute } from "@/app/api/syndicates/join/route";
import { GET as statusRoute } from "@/app/api/syndicates/[id]/route";

const CREATOR = "0x9196d7670eea0CB723af11465d4285541a2eA86a";
const JOINER_A = "0xdd68998C099f7570E59019ae35469E5603cEDA11";
const JOINER_B = "0x66D913034C8F5A2C096c706C4f437A59ec73f016"; // any well-formed address

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

function jsonReq(url: string, body: unknown): Request {
  return new Request(`http://test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createBatch(amount = 1) {
  const res = await createRoute(
    jsonReq("/api/syndicates/create", {
      creatorAddress: CREATOR,
      market: "SOMI:USDso",
      direction: "BUY",
      durationSeconds: 300,
      amount,
    }),
  );
  return { res, body: await res.json() };
}

describe("POST /api/syndicates/create", () => {
  it("creates a batch + creator intent and returns the invite id", async () => {
    const { res, body } = await createBatch(2);
    expect(res.status).toBe(201);
    expect(body.batchId).toMatch(/^squad-somi-[0-9a-f]{4}$/);
    expect(new Date(body.closesAt).getTime()).toBeGreaterThan(Date.now() + 250_000);
    expect(body.totalPool).toBe(2);
    expect(body.tradeId).toBeTruthy();
  });

  it("rejects amounts below the pool minimum before anything is saved", async () => {
    const res = await createRoute(jsonReq("/api/syndicates/create", {
      creatorAddress: CREATOR,
      market: "SOMI:USDso",
      direction: "BUY",
      durationSeconds: 60,
      amount: 0.05, // below minQty of 1 SOMI -- Phase 1 learning
    }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("below the pool minimum");
  });

  it("rejects malformed input", async () => {
    const res = await createRoute(jsonReq("/api/syndicates/create", {
      creatorAddress: "not-an-address",
      market: "SOMI:USDso",
      direction: "SIDEWAYS",
      durationSeconds: 45,
      amount: -3,
    }));
    expect([400, 500]).toContain(res.status); // validation error path
  });
});

describe("POST /api/syndicates/join", () => {
  it("accumulates the pool atomically and reports the new total", async () => {
    const { body: batch } = await createBatch(1);

    const a = await joinRoute(jsonReq("/api/syndicates/join", {
      userAddress: JOINER_A, batchId: batch.batchId, amount: 1.5,
    }));
    expect(a.status).toBe(201);

    const b = await joinRoute(jsonReq("/api/syndicates/join", {
      userAddress: JOINER_B, batchId: batch.batchId, amount: 2,
    }));
    const bBody = await b.json();
    expect(b.status).toBe(201);
    expect(bBody.totalPool).toBeCloseTo(4.5); // 1 creator + 1.5 + 2
  });

  it("rejects a duplicate pledge and rolls back the pool reservation", async () => {
    const { body: batch } = await createBatch(1);
    await joinRoute(jsonReq("/api/syndicates/join", {
      userAddress: JOINER_A, batchId: batch.batchId, amount: 1,
    }));

    const dup = await joinRoute(jsonReq("/api/syndicates/join", {
      userAddress: JOINER_A, batchId: batch.batchId, amount: 5,
    }));
    expect(dup.status).toBe(409);

    const status = await statusRoute(new Request(`http://test/x`), { params: Promise.resolve({ id: batch.batchId }) });
    const sBody = await status.json();
    expect(sBody.totalPool).toBe(2); // creator 1 + joiner 1, NOT +5
  });

  it("rejects pledges to an expired syndicate", async () => {
    const { body: batch } = await createBatch(1);
    // Force-expire directly in the DB; the worker will eventually sweep these.
    const { Batch } = await import("@/db/models/Batch");
    await Batch.findByIdAndUpdate(batch.batchId, { closesAt: new Date(Date.now() - 1000) });

    const late = await joinRoute(jsonReq("/api/syndicates/join", {
      userAddress: JOINER_A, batchId: batch.batchId, amount: 1,
    }));
    expect(late.status).toBe(409);
  });

  it("rejects under-sized pledges against the BATCH's market minimum", async () => {
    const { body: batch } = await createBatch(1);
    const small = await joinRoute(jsonReq("/api/syndicates/join", {
      userAddress: JOINER_A, batchId: batch.batchId, amount: 0.01,
    }));
    expect(small.status).toBe(400);
  });
});

describe("GET /api/syndicates/[id]", () => {
  it("returns scrubbed participants and pool volume", async () => {
    const { body: batch } = await createBatch(1.25);
    await joinRoute(jsonReq("/api/syndicates/join", {
      userAddress: JOINER_A, batchId: batch.batchId, amount: 1,
    }));

    const res = await statusRoute(new Request("http://test/x"), {
      params: Promise.resolve({ id: batch.batchId }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("OPEN");
    expect(body.creator).toMatch(/^0x9196\.\.\.A86a$/);
    expect(body.participants).toBe(2);
    expect(body.pledges.map((p: { user: string }) => p.user)).not.toContain(CREATOR);
    expect(body.timeRemainingMs).toBeGreaterThan(0);
    expect(body.receipt).toBeUndefined(); // only present once executed/failed
  });

  it("404s on an unknown slug", async () => {
    const res = await statusRoute(new Request("http://test/x"), {
      params: Promise.resolve({ id: "squad-nope-0000" }),
    });
    expect(res.status).toBe(404);
  });
});
