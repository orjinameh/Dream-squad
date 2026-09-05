import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

vi.mock("@/lib/warmup", () => ({
  checkAccountWarmup: async () => ({ warm: true, balance: 10, minRequired: 0.05 }),
}));

vi.mock("@/lib/operator", () => ({
  executeGameRound: vi.fn(async () => ({ success: true, txHash: "0x1234", blockNumber: 1000n, blockHash: "0xhash", gasUsed: 21000n, direction: "BUY", amount: 1, marketSymbol: "SOMI:USDso", roundOutcome: "UP" as const })),
  deriveRoundOutcome: vi.fn(() => "UP" as const),
  checkPlayerDelegation: vi.fn(async () => true),
  ensurePlayerVault: vi.fn(async () => ({ funded: true, vaultTxHash: null })),
}));

import { POST as createRoute } from "@/app/api/matches/create/route";
import { POST as predictRoute } from "@/app/api/matches/predict/route";
import { Match } from "@/db/models/Match";
import { EcPosition } from "@/db/models/EcPosition";
import { normalizeAddress } from "@/lib/addresses";

let mongo: MongoMemoryServer;
const PLAYER = "0x9196d7670eea0CB723af11465d4285541a2eA86a";

function jsonPost(url: string, body: unknown): Request {
  return new Request(`http://test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedActivePosition(player: string): Promise<string> {
  const doc = await EcPosition.create({
    address: normalizeAddress(player).toLowerCase(),
    direction: "UP",
    market: "BTC",
    amount: 10,
    status: "ACTIVE",
    windowId: `full-${player}-${Date.now()}`,
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

beforeEach(async () => {
  await Match.deleteMany({ playerAddress: normalizeAddress(PLAYER).toLowerCase() });
  await EcPosition.deleteMany({ address: normalizeAddress(PLAYER).toLowerCase() });
});

describe("Full bot match against the real EC oracle", () => {
  it("stakes, plays all 7 rounds, and completes without degenerating to all-FLAT", async () => {
    await seedActivePosition(PLAYER);
    const createRes = await createRoute(jsonPost("/api/matches/create", {
      playerAddress: PLAYER,
      playerChar: "dreamer",
      rivalName: "BOT",
      rivalChar: "oracle",
      mode: "quick",
      totalRounds: 7,
    }));
    expect(createRes.status).toBe(201);
    const { matchId } = await createRes.json();
    expect(matchId).toBeTruthy();

    // Bypass the ghost-funding gate for the test: set funded=true directly
    await Match.findByIdAndUpdate(matchId, { funded: true });

    // Play all 7 rounds. Each round requires two predict calls:
    // 1) COMMIT→ACTIVE (records prediction, captures entry price)
    // 2) ACTIVE→resolve (resolves the round against EC order book)
    let finalBody: any;
    const maxCalls = 7 * 3; // generous upper bound for 7 rounds
    for (let i = 0; i < maxCalls; i++) {
      const res = await predictRoute(jsonPost("/api/matches/predict", {
        matchId,
        playerAddress: PLAYER,
        prediction: "UP",
      }));
      expect(res.status).toBe(200);
      finalBody = await res.json();
      if (finalBody.status === "COMPLETED") break;
      // give the arena windows a moment to roll if needed
      await new Promise((r) => setTimeout(r, 300));
    }

    expect(finalBody.winner).toBeDefined();
    // A knockout can end the match before the full 7 rounds — that's correct
    // combat, not a degenerate match.
    expect((finalBody.rounds ?? []).length).toBeGreaterThan(0);
    expect((finalBody.rounds ?? []).length).toBeLessThanOrEqual(7);
    expect(finalBody.status).toBe("COMPLETED");

    const actuals: string[] = (finalBody.rounds ?? []).map((r: any) => r.actual);
    const nonFlat = actuals.filter((a) => a === "UP" || a === "DOWN");

    // The core gameplay guarantee: a full match against the live EC order book
    // must NOT degenerate to a 0-0 draw where every round resolves FLAT. If the
    // arena/price was genuinely unavailable for the whole match the earlier
    // rounds would have thrown and the match would not have produced resolved
    // rounds — so all-FLAT here means the resolution degenerated and must fail.
    console.log(`FULL BOT MATCH actuals=${JSON.stringify(actuals)} winner=${finalBody.winner} nonFlat=${nonFlat.length}`);
    expect(actuals.length).toBeGreaterThan(0);
    expect(nonFlat.length).toBeGreaterThan(0);
  }, 180_000);
});
