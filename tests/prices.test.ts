import { describe, expect, it } from "vitest";
import {
  generateMatchPriceModel,
  getAssetProfile,
  PRICE_POINTS_PER_ROUND,
  DEFAULT_ASSET,
} from "@/lib/prices";
import { fetchLivePriceUsd } from "@/lib/prices-api";

describe("generateMatchPriceModel (single continuous market)", () => {
  it("is deterministic for the same matchId", () => {
    const a = generateMatchPriceModel("match-A", "BTC", 7);
    const b = generateMatchPriceModel("match-A", "BTC", 7);

    expect(a.checkpoints).toEqual(b.checkpoints);
    expect(a.entryPrice).toBe(b.entryPrice);
    expect(a.asset).toBe(b.asset);
  });

  it("produces one checkpoint per round, each contiguous (end == next start)", () => {
    const m = generateMatchPriceModel("match-B", "BTC", 7);
    expect(m.checkpoints.length).toBe(7);
    for (let i = 1; i < m.checkpoints.length; i++) {
      const prev = m.checkpoints[i - 1];
      const cur = m.checkpoints[i];
      expect(cur.startPrice).toBe(prev.endPrice);
    }
  });

  it("treats BTC as the default asset", () => {
    const m = generateMatchPriceModel("match-C", undefined, 3);
    expect(m.asset).toBe(DEFAULT_ASSET);
    expect(m.entryPrice).toBe(getAssetProfile(DEFAULT_ASSET).basePrice);
  });

  it("has a full sparkline of PRICE_POINTS_PER_ROUND in each checkpoint", () => {
    const m = generateMatchPriceModel("match-D", "ETH", 5);
    for (const cp of m.checkpoints) {
      expect(cp.prices.length).toBe(PRICE_POINTS_PER_ROUND);
      expect(cp.startPrice).toBe(cp.prices[0]);
      expect(cp.endPrice).toBe(cp.prices[cp.prices.length - 1]);
      expect(["UP", "DOWN", "FLAT"]).toContain(cp.actual);
    }
  });

  it("scales within sane bounds relative to base price", () => {
    const base = getAssetProfile("BTC").basePrice;
    const m = generateMatchPriceModel("match-E", "BTC", 7);
    for (const cp of m.checkpoints) {
      for (const p of cp.prices) {
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThan(base * 2);
      }
    }
  });

  it("agrees on the resolved direction: end > start means UP (outside flat band)", () => {
    const flatBand = getAssetProfile("BTC").flatBandPct;
    for (let i = 0; i < 200; i++) {
      const m = generateMatchPriceModel(`seed-check:${i}`, "BTC", 3);
      for (const cp of m.checkpoints) {
        const movePct = Math.abs(cp.endPrice - cp.startPrice) / cp.startPrice;
        if (movePct < flatBand) {
          expect(cp.actual).toBe("FLAT");
        } else if (cp.endPrice > cp.startPrice) {
          expect(cp.actual).toBe("UP");
        } else {
          expect(cp.actual).toBe("DOWN");
        }
      }
    }
  });
});

describe("fetchLivePriceUsd (authoritative resolution), no network dependency", () => {
  it("returns null for the default SOMI market (no public ticker) — the timeout fallback", async () => {
    expect(await fetchLivePriceUsd("SOMI:USDso")).toBeNull();
  });

  it("returns null for unknown markets and never throws", async () => {
    await expect(fetchLivePriceUsd("NOPE:USDso")).resolves.toBeNull();
    await expect(fetchLivePriceUsd("")).resolves.toBeNull();
  });
});
