// DreamDuel market model: ONE continuous binary trade per match.
//
// The whole match trades against a single, deterministic market price path
// (seeded by matchId) that both players and the chart all observe. Rounds are
// live CHECKPOINTS along that one path — the price never randomly resets
// between rounds. Your binary position (UP/DOWN, changeable between rounds) is
// evaluated against each checkpoint. The chart, the per-round combat result,
// and the mark-to-market P&L all derive from this same model, so a judge sees
// one coherent market across the whole fight.

export interface Checkpoint {
  roundNum: number;
  startPrice: number;
  endPrice: number;
  prices: number[]; // sparkline points within this round
  actual: "UP" | "DOWN" | "FLAT";
}

export interface MatchPriceModel {
  asset: string;
  entryPrice: number; // price at match start (before round 1)
  checkpoints: Checkpoint[]; // one per round, contiguous (end == next start)
}

export interface AssetProfile {
  asset: string;
  basePrice: number;
  volatility: number;
  decimals: number;
  flatBandPct: number;
}

export const ASSET_PROFILES: Record<string, AssetProfile> = {
  BTC: { asset: "BTC", basePrice: 67420, volatility: 0.004, decimals: 2, flatBandPct: 0.0006 },
  ETH: { asset: "ETH", basePrice: 3520, volatility: 0.006, decimals: 2, flatBandPct: 0.001 },
  SOMI: { asset: "SOMI", basePrice: 0.1, volatility: 0.01, decimals: 4, flatBandPct: 0.008 },
};

export const DEFAULT_ASSET = "BTC";
export const PRICE_POINTS_PER_ROUND = 24; // sparkline density per 10-second round

export function getAssetProfile(asset: string | undefined): AssetProfile {
  return ASSET_PROFILES[asset ?? DEFAULT_ASSET] ?? ASSET_PROFILES[DEFAULT_ASSET];
}

/** Deterministic PRNG (mulberry32). */
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

/** FNV-1a string hash to a 32-bit seed. */
function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function roundPrice(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function toActual(start: number, end: number, flatBandPct: number): "UP" | "DOWN" | "FLAT" {
  const moveAbs = Math.abs(end - start) / start;
  if (moveAbs < flatBandPct) return "FLAT";
  return end > start ? "UP" : "DOWN";
}

/**
 * Build the single continuous price model for an entire match.
 * `totalRounds` checkpoints are carved from one multiplicative random-walk path
 * (with a slight upward drift so the market isn't dead). Round N's end price is
 * round N+1's start price — no discontinuity.
 */
export function generateMatchPriceModel(
  matchId: string,
  asset: string | undefined,
  totalRounds: number,
): MatchPriceModel {
  const profile = getAssetProfile(asset);
  const rnd = mulberry32(hashSeed(matchId));

  let price = profile.basePrice;
  const checkpoints: Checkpoint[] = [];

  for (let round = 1; round <= totalRounds; round++) {
    const startPrice = roundPrice(price, profile.decimals);
    const prices: number[] = [startPrice];
    const drift = profile.volatility * 0.15;

    // Random walk within this round's checkpoint (contiguous from start).
    for (let i = 1; i < PRICE_POINTS_PER_ROUND; i++) {
      const change = (rnd() - 0.45 + drift) * price * profile.volatility;
      price = Math.max(price + change, profile.basePrice * 0.4);
      prices.push(roundPrice(price, profile.decimals));
    }

    const endPrice = roundPrice(price, profile.decimals);
    checkpoints.push({
      roundNum: round,
      startPrice,
      endPrice,
      prices,
      actual: toActual(startPrice, endPrice, profile.flatBandPct),
    });
  }

  return {
    asset: profile.asset,
    entryPrice: checkpoints[0].startPrice,
    checkpoints,
  };
}
