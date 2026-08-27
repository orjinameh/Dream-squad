// Deterministic per-round market price generation.
//
// DreamDuel is "trade with a twist". Every round has a single, coherent market
// price series that the chart and the authoritative outcome BOTH derive from.
// The series is generated deterministically from a seed (matchId + roundNum so
// both players in a round observe the identical price path) rather than a
// per-client random walk. This guarantees the chart the player watches and the
// UP/DOWN/FLAT result the server resolves are always the same.

export interface RoundPriceSeries {
  asset: string;
  startPrice: number;
  endPrice: number;
  prices: number[];
  actual: "UP" | "DOWN" | "FLAT";
}

export interface AssetProfile {
  /** Display asset key (matches client chart). */
  asset: string;
  /** Pseudo USD base price used to anchor the series. */
  basePrice: number;
  /** Fractional volatility applied per step. */
  volatility: number;
  /** Decimals used for display rounding. */
  decimals: number;
  /** Small % band around start under which a round is FLAT (no damage). */
  flatBandPct: number;
}

export const ASSET_PROFILES: Record<string, AssetProfile> = {
  BTC: { asset: "BTC", basePrice: 67420, volatility: 0.002, decimals: 2, flatBandPct: 0.0006 },
  ETH: { asset: "ETH", basePrice: 3520, volatility: 0.003, decimals: 2, flatBandPct: 0.001 },
  SOMI: { asset: "SOMI", basePrice: 0.1, volatility: 0.005, decimals: 4, flatBandPct: 0.008 },
};

export const DEFAULT_ASSET = "BTC";
export const DEFAULT_QUESTION = "WILL BTC GO UP OR DOWN?";
export const PRICE_POINTS = 30; // number of points rendered on the sparkline

/** Deterministic PRNG (mulberry32). Seeded so repeated calls reproduce a path. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash → 32-bit seed. */
function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function getAssetProfile(asset: string | undefined): AssetProfile {
  return ASSET_PROFILES[asset ?? DEFAULT_ASSET] ?? ASSET_PROFILES[DEFAULT_ASSET];
}

/**
 * Generate the full deterministic price series for a round.
 * `seedKey` should be unique per round across the whole match
 * (e.g. `${matchId}:${roundNum}`) so the same round yields the same path.
 */
export function generateRoundSeries(seedKey: string, asset: string | undefined): RoundPriceSeries {
  const profile = getAssetProfile(asset);
  const rnd = mulberry32(hashSeed(seedKey));

  let price = profile.basePrice;
  const prices: number[] = [price];
  for (let i = 1; i < PRICE_POINTS; i++) {
    // Slight upward drift so rounds aren't all boring; keep the twist lively.
    const drift = profile.volatility * 0.15;
    const change = (rnd() - 0.45 + drift) * price * profile.volatility;
    price = Math.max(price + change, profile.basePrice * 0.5);
    prices.push(round(price, profile.decimals));
  }

  const startPrice = prices[0];
  const endPrice = prices[prices.length - 1];
  const movePct = Math.abs(endPrice - startPrice) / startPrice;

  const actual: "UP" | "DOWN" | "FLAT" =
    movePct < profile.flatBandPct ? "FLAT"
    : endPrice > startPrice ? "UP"
    : "DOWN";

  return { asset: profile.asset, startPrice, endPrice, prices, actual };
}

export function round(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}
