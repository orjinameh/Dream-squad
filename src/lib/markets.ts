// Market metadata for API-layer validation of trade intents.
//
// Values observed on Shannon testnet via scripts/doctor.ts + the Phase 1 spike
// (Aug 2026). The API must enforce pool minimums BEFORE an intent is saved --
// the pool rejects under-sized orders with QuantityBelowMinimum(uint256,uint256)
// at execution time, and by then the syndicate sweep has already paid gas.

export interface MarketConfig {
  /** Canonical pair symbol as used by dreamdex-bot-kit MARKETS. */
  symbol: string;
  /** Pool contract on Shannon testnet. */
  pool: `0x${string}`;
  /** Base token display decimals. */
  baseDecimals: number;
  /** Quote token display decimals (always 18 for USDso pairs). */
  quoteDecimals: number;
  /** Minimum order size in human base units (pool minQuantity). */
  minAmount: number;
  /** Lot size in human base units -- amounts snap down to this grid. */
  lotSize: number;
}

/** Execution gas floor per order placement. The Phase 1 spike saw ~865k-985k
 *  consumed; 1.5M leaves headroom without being wasteful. */
export const GAS_LIMIT_PER_ORDER = 1_500_000n;

/** Minimum native balance the operator wallet needs before we consider it
 *  "warm". Somnia raw nodes reject broadcasts from never-funded accounts
 *  ("account does not exist") and from zero-balance senders. */
export const OPERATOR_MIN_GAS_BUFFER = 0.05; // STT

export const MARKETS: Record<string, MarketConfig> = {
  "SOMI:USDso": {
    symbol: "SOMI:USDso",
    pool: "0x259fD6559214dd5aD3752322426eA9F9fABEFff4",
    baseDecimals: 18,
    quoteDecimals: 18,
    minAmount: 1,
    lotSize: 0.01,
  },
  "WETH:USDso": {
    symbol: "WETH:USDso",
    pool: "0xD180195da5459C7a0DEA188ed61216ec43682b50",
    baseDecimals: 18,
    quoteDecimals: 18,
    minAmount: 0.001,
    lotSize: 0.001,
  },
  "WBTC:USDso": {
    symbol: "WBTC:USDso",
    pool: "0x3605f28aA7C50e7441211e77Cb0762d49539326C",
    baseDecimals: 8,
    quoteDecimals: 18,
    minAmount: 0.0001,
    lotSize: 0.00001,
  },
};

export function getMarket(symbol: string): MarketConfig | undefined {
  return MARKETS[symbol];
}

/** True when `amount` clears the pool minimum and sits on the lot grid. */
export function amountMeetsMinimum(market: MarketConfig, amount: number): boolean {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  if (amount < market.minAmount - Number.EPSILON) return false;
  const lots = Math.round(amount / market.lotSize);
  return Math.abs(lots * market.lotSize - amount) < Number.EPSILON;
}

/**
 * Snap a desired stake onto the market's lot grid and floor it at the pool
 * minimum so the resulting on-chain order is never under-sized. Non-finite or
 * zero/negative inputs fall back to the market minimum.
 */
export function snapAmount(raw: number, minAmount: number, lotSize: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return minAmount;
  const lots = Math.max(1, Math.round(raw / lotSize));
  return Math.max(minAmount, lots * lotSize);
}
