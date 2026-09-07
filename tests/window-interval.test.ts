import { describe, expect, it } from "vitest";
import { EC_WINDOW_INTERVAL_SEC } from "@/lib/ec/config";
import {
  isPreferredWindowInterval,
  preferWindowInterval,
  unifiedWindowIntervalSec,
} from "@/lib/ec/executor";

describe("5-minute window preference", () => {
  it("targets the 300s cadence", () => {
    expect(EC_WINDOW_INTERVAL_SEC).toBe(300);
  });

  it("recognizes the 300s cadence in indexer and numeric forms", () => {
    expect(isPreferredWindowInterval("300")).toBe(true);
    expect(isPreferredWindowInterval(300)).toBe(true);
    expect(isPreferredWindowInterval("301")).toBe(true); // off-by-one row
    expect(isPreferredWindowInterval("60")).toBe(false);
    expect(isPreferredWindowInterval("900")).toBe(false);
    expect(isPreferredWindowInterval(null)).toBe(false);
    expect(isPreferredWindowInterval(undefined)).toBe(false);
    expect(isPreferredWindowInterval("abc")).toBe(false);
  });

  it("orders 5-minute windows first, 15-minute fallback next, stably", () => {
    const rows = [
      { id: "1h", intervalSec: "3600" },
      { id: "5m-late", intervalSec: "300" },
      { id: "15m", intervalSec: 900 },
      { id: "1m", intervalSec: 60 },
      { id: "5m-early", intervalSec: 300 },
      { id: "unknown", intervalSec: null },
    ];
    const ordered = preferWindowInterval(rows, (r) => r.intervalSec).map((r) => r.id);
    // Preferred keep expiry order at the front, then the 15m fallback series,
    // then everything else untouched.
    expect(ordered.slice(0, 2)).toEqual(["5m-late", "5m-early"]);
    expect(ordered[2]).toBe("15m");
    expect(ordered.slice(3)).toEqual(["1h", "1m", "unknown"]);
  });

  it("falls back to the 15m series when the 5m series gaps", () => {
    const rows = [
      { id: "1h", intervalSec: "3600" },
      { id: "15m", intervalSec: "900" },
    ];
    expect(preferWindowInterval(rows, (r) => r.intervalSec).map((r) => r.id)).toEqual(["15m", "1h"]);
    expect(preferWindowInterval([], (r: { intervalSec: string | null }) => r.intervalSec)).toEqual([]);
  });

  it("derives unified cadence from intervalSec, else the window span", () => {
    expect(unifiedWindowIntervalSec({ intervalSec: "300" })).toBe(300);
    expect(unifiedWindowIntervalSec({ expiry: 1300, tradingStart: 1000 })).toBe(300);
    expect(unifiedWindowIntervalSec({})).toBe(null);
  });
});
