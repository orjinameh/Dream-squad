import { describe, expect, it } from "vitest";
import {
  buildMatchPriceModel,
  toActual,
} from "@/lib/prices";
import { fetchLivePriceUsd } from "@/lib/prices-api";

describe("buildMatchPriceModel (real-price, no simulation)", () => {
  it("stores the real entry price and asset, with no precomputed checkpoints", () => {
    const m = buildMatchPriceModel("BTC", 78100);
    expect(m.asset).toBe("BTC");
    expect(m.entryPrice).toBe(78100);
    expect(m.checkpoints).toEqual([]);
  });

  it("normalizes the asset to uppercase and defaults to BTC", () => {
    expect(buildMatchPriceModel("eth", 2400).asset).toBe("ETH");
    expect(buildMatchPriceModel(undefined as any, 100).asset).toBe("BTC");
  });

  it("checkpoints are appended (real resolved rounds), never pre-seeded", () => {
    const m = buildMatchPriceModel("ETH", 2400);
    expect(m.checkpoints.length).toBe(0);
    m.checkpoints.push({ roundNum: 1, startPrice: 2400, endPrice: 2450, prices: [2400, 2450], actual: "UP" });
    expect(m.checkpoints.length).toBe(1);
    expect(m.checkpoints[0].actual).toBe("UP");
  });
});

describe("toActual (real move classification)", () => {
  it("classifies a move inside the flat band as FLAT", () => {
    expect(toActual(100, 100.001, 0.0005)).toBe("FLAT");
  });
  it("classifies a move above the band as UP", () => {
    expect(toActual(100, 100.1, 0.0005)).toBe("UP");
  });
  it("classifies a move below the band as DOWN", () => {
    expect(toActual(100, 99.9, 0.0005)).toBe("DOWN");
  });
  it("returns FLAT for a non-positive open (no fabricated direction)", () => {
    expect(toActual(0, 100, 0.0005)).toBe("FLAT");
  });
});

describe("fetchLivePriceUsd (authoritative resolution), no external API", () => {
  it("returns null for the default SOMI market (no DreamDEX oracle row)", async () => {
    expect(await fetchLivePriceUsd("SOMI:USDso")).toBeNull();
  });

  it("returns null for unknown markets and never throws", async () => {
    await expect(fetchLivePriceUsd("NOPE:USDso")).resolves.toBeNull();
    await expect(fetchLivePriceUsd("")).resolves.toBeNull();
    await expect(fetchLivePriceUsd("ABC")).resolves.toBeNull();
  });
});
