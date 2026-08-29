/**
 * Live market price feed for authoritative round resolution.
 *
 * Fetches a real USD ticker for the base asset of a DreamDuel market so that a
 * round's UP/DOWN/FLAT outcome tracks the actual market instead of a synthetic
 * path. Every fetch is bounded by a timeout, and unsupported assets (or any
 * failure) return `null` so the caller can fall back to its precomputed model
 * and the round is never hard-freezed waiting on a network call.
 */

const TICKER_TIMEOUT_MS = 2500;

/** Quote asset on the public feeds we can reach (USD vs the custom USDso). */
export type PublicBase = "BTC" | "ETH";

/**
 * Real-Pair mapping. Only assets with a live, public USD ticker are resolvable
 * live. Everything else (e.g. the native SOMI token, which is a testnet asset
 * with no public ticker) returns `undefined` and defers to the fallback model.
 */
const PUBLIC_PAIRS: Partial<Record<string, PublicBase>> = {
  WETH: "ETH",
  WBTC: "BTC",
};

async function fetchWithTimeout(url: string, ms: number): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCoinbase(base: PublicBase): Promise<number | null> {
  const pair = base === "BTC" ? "BTC-USD" : "ETH-USD";
  const raw = await fetchWithTimeout(`https://api.coinbase.com/v2/prices/${pair}/spot`, TICKER_TIMEOUT_MS);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const price = Number(data?.data?.amount);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function fetchBinance(base: PublicBase): Promise<number | null> {
  const pair = base === "BTC" ? "BTCUSDT" : "ETHUSDT";
  const raw = await fetchWithTimeout(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`, TICKER_TIMEOUT_MS);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const price = Number(data?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * Fetch a live USD price for a DreamDuel market symbol.
 *
 * Tries Coinbase then Binance; returns the first success. Returns `null` when
 * the asset has no public ticker, both feeds fail, or both time out — never
 * throws, so resolution can always proceed.
 */
export async function fetchLivePriceUsd(marketSymbol: string): Promise<number | null> {
  const base = marketSymbol.split(":")[0];
  const publicBase = PUBLIC_PAIRS[base];
  if (!publicBase) return null;

  const cb = await fetchCoinbase(publicBase);
  if (cb != null) return cb;
  return fetchBinance(publicBase);
}
