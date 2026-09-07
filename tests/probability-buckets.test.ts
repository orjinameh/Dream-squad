// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { bucketCandles, type TickPoint } from "@/game/ProbabilityChart";

describe("bucketCandles (5s probability candles)", () => {
  it("builds OHLC + volume per bucket from fill ticks", () => {
    const points: TickPoint[] = [
      { t: 101, p: 0.40, v: 2 },
      { t: 102, p: 0.45, v: 3 },
      { t: 103, p: 0.42, v: 1 },
      { t: 107, p: 0.50, v: 4 },
    ];
    const { candles, volumes } = bucketCandles(points, null, 5);
    // Buckets [100,105) and [105,110)
    expect(candles.length).toBe(2);
    expect(candles[0]).toMatchObject({ open: 0.40, high: 0.45, low: 0.40, close: 0.42 });
    expect(candles[1]).toMatchObject({ open: 0.50, high: 0.50, low: 0.50, close: 0.50 });
    expect(volumes[0].value).toBe(6);
    expect(volumes[1].value).toBe(4);
    // Up candle green, down red
    expect(volumes[0].color).toContain("16,185,129");
    expect(volumes[1].color).toContain("16,185,129");
  });

  it("renders a single-tick bucket as a flat doji, never fabricates empties", () => {
    const points: TickPoint[] = [{ t: 101, p: 0.40, v: 2 }];
    const { candles, volumes } = bucketCandles(points, null, 5);
    expect(candles.length).toBe(1);
    expect(candles[0]).toMatchObject({ open: 0.40, high: 0.40, low: 0.40, close: 0.40 });
    expect(volumes[0].value).toBe(2);
  });

  it("rolls the live edge into the forming bucket without adding volume", () => {
    const points: TickPoint[] = [{ t: 101, p: 0.40, v: 2 }];
    const { candles, volumes } = bucketCandles(points, { t: 104, p: 0.44, v: 0 }, 5);
    expect(candles.length).toBe(1);
    expect(candles[0]).toMatchObject({ open: 0.40, high: 0.44, low: 0.40, close: 0.44 });
    expect(volumes[0].value).toBe(2);
  });

  it("colors down candles red", () => {
    const points: TickPoint[] = [
      { t: 101, p: 0.50, v: 1 },
      { t: 102, p: 0.46, v: 1 },
    ];
    const { volumes } = bucketCandles(points, null, 5);
    expect(volumes[0].color).toContain("239,68,68");
  });

  it("returns empty series for empty tape", () => {
    const { candles, volumes } = bucketCandles([], null, 5);
    expect(candles).toEqual([]);
    expect(volumes).toEqual([]);
  });
});
