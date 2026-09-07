import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

// Real fills on the pinned window (0.42 → 0.47 YES), plus decoys: fills from a
// PREVIOUS market on the recycled pool, and out-of-range prices. The tape must
// carry only this window's fills with probabilities clamped to [$0.01, $0.99].
const NOW = Math.floor(Date.now() / 1000);
const MARKET = "0xtape";
const POOL = "0x0000000000000000000000000000000000000tape";

vi.mock("@/lib/ec/arena", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ec/arena")>();
  return {
    ...actual,
    ecArenaForMatch: vi.fn(async () => ({
      symbol: "BTC-TAPE-01JAN30-0000/tUSDC",
      marketId: MARKET,
      pool: POOL,
      expiry: NOW + 600,
    })),
  };
});

vi.mock("@/lib/ec/executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ec/executor")>();
  return {
    ...actual,
    readArenaPrice: vi.fn(async () => ({
      yesPrice: 0.49,
      bestBid: 0.48,
      bestAsk: 0.50,
      updatedMs: Date.now(),
    })),
    findArenaFloor: vi.fn(async () => ({
      symbol: "BTC-TAPE-01JAN30-0000/tUSDC",
      marketId: MARKET,
      pool: POOL,
      expiry: NOW + 600,
    })),
  };
});

const ALL_FILLS = [
  // newest-first, as the indexer returns them
  { fillPrice: "2000000", timestamp: String(NOW - 2), market_id: MARKET, pool: POOL, quoteQuantity: "4000000" }, // p=2.0 → clamped 0.99
  { fillPrice: "470000", timestamp: String(NOW - 5), market_id: MARKET, pool: POOL, quoteQuantity: "940000" },
  { fillPrice: "420000", timestamp: String(NOW - 9), market_id: MARKET, pool: POOL, quoteQuantity: "840000" },
  { fillPrice: "5000", timestamp: String(NOW - 12), market_id: MARKET, pool: POOL, quoteQuantity: "10000" }, // p=0.005 → clamped 0.01
  { fillPrice: "900000", timestamp: String(NOW - 20), market_id: "0xoldmarket", pool: POOL, quoteQuantity: "1800000" }, // recycled pool, old window
];

const fillFetch = vi.fn(async (url: string, init?: any) => {
  // Emulate the indexer's server-side where-filter (pool + market window).
  let rows = ALL_FILLS;
  try {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const q = String(body.query ?? "");
    const poolM = q.match(/pool:\s*\{\s*_eq:\s*"([^"]+)"/);
    const mktM = q.match(/market_id:\s*\{\s*_eq:\s*"([^"]+)"/);
    if (poolM) rows = rows.filter((r) => r.pool === poolM[1]);
    if (mktM) rows = rows.filter((r) => r.market_id === mktM[1]);
  } catch { /* return all on parse failure */ }
  return {
    ok: true,
    json: async () => ({ data: { Fill: rows } }),
  };
});
vi.stubGlobal("fetch", fillFetch);

import { GET as tapeRoute } from "@/app/api/matches/ec-tape/route";
import { Match } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { buildMatchPriceModel } from "@/lib/prices";

let mongo: MongoMemoryServer;
const PLAYER = "0x9196d7670eea0CB723af11465d4285541a2eA86a";

function jsonGet(url: string): Request {
  return new Request(`http://test${url}`);
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  vi.unstubAllGlobals();
});

describe("GET /api/matches/ec-tape", () => {
  it("serves this window's probability tape, clamped, with live edge + entry", async () => {
    const addr = normalizeAddress(PLAYER).toLowerCase();
    await Match.deleteMany({ playerAddress: addr });
    const priceModel: any = buildMatchPriceModel("BTC", 78000);
    priceModel.arenaOpen = 0.45;
    const doc = await Match.create({
      _id: `test-tape-${Date.now()}`,
      playerAddress: addr,
      playerChar: "dreamer",
      rivalName: "BOT",
      rivalChar: "oracle",
      mode: "quick",
      totalRounds: 7,
      currentRound: 2,
      roundPhase: "ACTIVE",
      roundStartTime: new Date(),
      roundDeadline: new Date(Date.now() + 60_000),
      status: "ACTIVE",
      opponentType: "bot",
      funded: true,
      predictionAsset: "BTC",
      priceModel,
    });

    const res = await tapeRoute(jsonGet(`/api/matches/ec-tape?matchId=${doc._id}`));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.marketId).toBe(MARKET);
    expect(body.live).toBe(true);
    // Old-window decoy excluded; ascending time order
    const probs = body.points.map((p: any) => p.p);
    expect(probs).toEqual([0.01, 0.42, 0.47, 0.99]);
    const times = body.points.map((p: any) => p.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // Live edge = current top-of-book mid with zero volume (polls move price)
    expect(body.edge.p).toBeCloseTo(0.49, 6);
    expect(body.edge.v).toBe(0);
    // Fill points carry real traded value
    for (const pt of body.points) {
      expect(typeof pt.v).toBe("number");
      expect(pt.v).toBeGreaterThan(0);
    }
    // Entry anchor + direction vs the live edge (0.49 > 0.45 → UP)
    expect(body.entry).toBeCloseTo(0.45, 6);
    expect(body.direction).toBe("UP");
  });

  it("serves the floor arena in asset mode", async () => {
    const res = await tapeRoute(jsonGet("/api/matches/ec-tape?asset=ETH"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.marketId).toBe(MARKET);
    expect(body.points.length).toBeGreaterThan(0);
  });

  it("rejects missing/invalid params", async () => {
    expect((await tapeRoute(jsonGet("/api/matches/ec-tape"))).status).toBe(400);
    expect((await tapeRoute(jsonGet("/api/matches/ec-tape?asset=DOGE"))).status).toBe(400);
  });
});
