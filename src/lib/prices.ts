// DreamDuel market model: ONE continuous real market per match, driven by the
// DreamDEX on-chain price feed. There is NO simulated random-walk path — every
// round's outcome, chart, and P&L derive from actual BTC/ETH oracle prices.
//
// The model stores the REAL entry price taken at match start; each round is then
// resolved live (anchor vs. the oracle spot at close) by the server and recorded
// as a checkpoint after the fact. Future rounds are not precomputed — you cannot
// predict real prices ahead of time.

export interface Checkpoint {
  roundNum: number;
  startPrice: number;
  endPrice: number;
  prices: number[]; // [start, end]
  actual: "UP" | "DOWN" | "FLAT";
}

export interface MatchPriceModel {
  asset: string;
  entryPrice: number; // real oracle price at match start (before round 1)
  checkpoints: Checkpoint[]; // real resolved rounds, appended by the server
}

/** Build a real-price anchor model for a match. `entryPrice` is the observed
 *  BTC/ETH oracle spot at match creation (real, never synthesized). */
export function buildMatchPriceModel(asset: string, entryPrice: number): MatchPriceModel {
  return { asset: (asset || "BTC").toUpperCase(), entryPrice, checkpoints: [] };
}

/** Classify a real price move into UP/DOWN/FLAT. */
export function toActual(start: number, end: number, flatBandPct: number): "UP" | "DOWN" | "FLAT" {
  if (!(start > 0)) return "FLAT";
  const moveAbs = Math.abs(end - start) / start;
  if (moveAbs < flatBandPct) return "FLAT";
  return end > start ? "UP" : "DOWN";
}
