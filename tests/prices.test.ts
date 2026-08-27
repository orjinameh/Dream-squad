import { describe, expect, it } from "vitest";
import { generateRoundSeries, getAssetProfile, PRICE_POINTS, DEFAULT_ASSET } from "@/lib/prices";

describe("generateRoundSeries", () => {
  it("is deterministic for the same seed key", () => {
    const a = generateRoundSeries("match:1", "BTC");
    const b = generateRoundSeries("match:1", "BTC");

    expect(a.prices).toEqual(b.prices);
    expect(a.startPrice).toBe(b.startPrice);
    expect(a.endPrice).toBe(b.endPrice);
    expect(a.actual).toBe(b.actual);
  });

  it("produces a full series of PRICE_POINTS", () => {
    const s = generateRoundSeries("match:2", "BTC");
    expect(s.prices.length).toBe(PRICE_POINTS);
    expect(s.startPrice).toBe(s.prices[0]);
    expect(s.endPrice).toBe(s.prices[s.prices.length - 1]);
    expect(["UP", "DOWN", "FLAT"]).toContain(s.actual);
  });

  it("treats BTC as the default asset", () => {
    const s = generateRoundSeries("match:3", undefined);
    expect(s.asset).toBe(DEFAULT_ASSET);
    expect(s.prices.length).toBe(PRICE_POINTS);
  });

  it("scales within sane bounds relative to base price", () => {
    const base = getAssetProfile("BTC").basePrice;
    const s = generateRoundSeries("match:4", "BTC");
    for (const p of s.prices) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(base * 2);
    }
  });

  it("agrees on the resolved direction: end > start means UP (outside flat band)", () => {
    // Run many seeds and assert the `actual` matches the price delta whenever
    // the move clears the flat band (chart and resolution must stay coherent).
    for (let i = 0; i < 200; i++) {
      const s = generateRoundSeries(`seed-check:${i}`, "BTC");
      const flatBand = getAssetProfile("BTC").flatBandPct;
      const movePct = Math.abs(s.endPrice - s.startPrice) / s.startPrice;
      if (movePct < flatBand) {
        expect(s.actual).toBe("FLAT");
      } else if (s.endPrice > s.startPrice) {
        expect(s.actual).toBe("UP");
      } else {
        expect(s.actual).toBe("DOWN");
      }
    }
  });
});
