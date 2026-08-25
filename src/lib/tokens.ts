// Token registry for multi-asset pledges.
//
// On Shannon testnet we approximate USD prices.  The executor still places a
// single IOC order in the market's base token -- the aggregation happens here
// at the API layer so the executor remains unchanged.

export interface TokenConfig {
  symbol: string;
  decimals: number;
  /** Approximate USD price on Shannon testnet. */
  usdPrice: number;
  /** Minimum pledge in human units (below this = dust, ignored unless dustSweep). */
  dustThreshold: number;
}

export const TOKENS: Record<string, TokenConfig> = {
  STT:  { symbol: "STT",  decimals: 18, usdPrice: 0.10, dustThreshold: 0.01 },
  SOMI: { symbol: "SOMI", decimals: 18, usdPrice: 0.10, dustThreshold: 0.1 },
  USDC: { symbol: "USDC", decimals: 6,  usdPrice: 1.00, dustThreshold: 0.10 },
  WETH: { symbol: "WETH", decimals: 18, usdPrice: 3500, dustThreshold: 0.00001 },
};

export interface PledgeAsset {
  symbol: string;
  amount: number; // human-readable units
}

export interface ResolvedAsset extends PledgeAsset {
  usdValue: number;
}

/** Convert a list of pledged assets into a single base-token quantity for a market.
 *  `marketPrice` is the USD price of the market's base token (e.g. SOMI = $0.10). */
export function aggregateAssets(
  assets: PledgeAsset[],
  marketBaseDecimals: number,
  marketBaseUsdPrice: number,
): { totalBaseAmount: number; resolved: ResolvedAsset[] } {
  let totalUsd = 0;
  const resolved: ResolvedAsset[] = [];

  for (const a of assets) {
    const cfg = TOKENS[a.symbol];
    if (!cfg || a.amount <= 0) continue;
    const usd = a.amount * cfg.usdPrice;
    totalUsd += usd;
    resolved.push({ symbol: a.symbol, amount: a.amount, usdValue: +usd.toFixed(6) });
  }

  // Convert total USD to base-token quantity, snapped to lot grid (2 decimals)
  const totalBaseAmount = +(totalUsd / marketBaseUsdPrice).toFixed(6);
  return { totalBaseAmount, resolved };
}

/** Filter dust-only assets below threshold. Returns true if pledge is dust. */
export function isDustOnly(assets: PledgeAsset[]): boolean {
  return assets.every((a) => {
    const cfg = TOKENS[a.symbol];
    return cfg ? a.amount < cfg.dustThreshold : true;
  });
}
