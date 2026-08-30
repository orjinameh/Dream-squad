/**
 * Authoritative market price feed for round resolution.
 *
 * Real BTC/ETH prices come from the DreamDEX on-chain price feed (Somnia's
 * oracle) — no external exchange API. Unsupported assets (e.g. SOMI, with no
 * oracle row) return `null`. A supported asset whose read fails throws, so the
 * caller can treat it as a failed resolution (never a fake price).
 */

import { baseToFeedAsset, fetchSpotAsset, FEED_ATTEMPTS } from "@/lib/price-feed";

const TICKER_TIMEOUT_MS = 2500;

/**
 * Fetch a live BTC/ETH price (USDC-quoted, from the DreamDEX oracle) for a
 * DreamDuel market symbol.
 *
 * - Unsupported base (SOMI, unknown, empty) -> null (no feed row).
 * - Supported BTC/ETH -> the real spot price; throws if the oracle read fails.
 */
export async function fetchLivePriceUsd(marketSymbol: string): Promise<number | null> {
  const base = String(marketSymbol ?? "").split(":")[0];
  const feedAsset = baseToFeedAsset(base);
  if (!feedAsset) return null;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < FEED_ATTEMPTS; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TICKER_TIMEOUT_MS);
      try {
        const price = await fetchSpotAsset(feedAsset, ctrl.signal);
        if (price > 0) return price;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`DreamDEX feed failed for ${marketSymbol}`);
}
