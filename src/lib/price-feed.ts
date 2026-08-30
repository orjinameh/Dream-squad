/**
 * DreamDEX on-chain price feed — the single real source for DreamDuel prices.
 *
 * Read-only Hasura GraphQL over Somnia's on-chain price oracle:
 *   https://price-feed.dev.oracle.somnia.host/v1/graphql
 * No external API, no key. See @somnia-chain/markets-sdk (dist/priceFeed).
 *
 * Values are 1e18-scaled strings; decoded via the row's `decimals` (18).
 * Errors PROPAGATE: this feed is the source of truth, so callers handle a
 * failed read as a failed resolution (no synthetic fallback anywhere).
 */

export const PRICE_FEED_URL = "https://price-feed.dev.oracle.somnia.host/v1/graphql";

/** Pin a single quote per base so a base never resolves to multiple feeds. */
export const PRICE_FEED_QUOTE = "USDC";

/** Assets DreamDEX's oracle tracks that we trade. */
export type FeedAsset = "BTC" | "ETH";

async function graphql(
  query: string,
  variables: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<any> {
  const res = await fetch(PRICE_FEED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`DreamDEX feed HTTP ${res.status}`);
  const json = await res.json();
  if (json?.errors?.length) throw new Error(`DreamDEX feed: ${json.errors[0].message}`);
  return json.data;
}

/**
 * Latest spot price (human units) for an asset from the oracle's Feed row.
 * Throws when the feed is unreachable or the asset has no row — there is no
 * fake/fallback price.
 */
export async function fetchSpotAsset(asset: FeedAsset, signal?: AbortSignal): Promise<number> {
  const data = await graphql(
    `query Feed($base: String!, $quote: String!) {
      Feed(where: { base: { _eq: $base }, quote: { _eq: $quote } }) {
        base quote latestSpot decimals
      }
    }`,
    { base: asset.toUpperCase(), quote: PRICE_FEED_QUOTE },
    signal,
  );
  const feed = data?.Feed?.[0];
  if (!feed || feed.latestSpot == null) throw new Error(`DreamDEX feed: no spot for ${asset}`);
  const decimals = feed.decimals ?? 18;
  const price = Number(feed.latestSpot) / 10 ** decimals;
  if (!Number.isFinite(price) || price <= 0) throw new Error(`DreamDEX feed: bad spot for ${asset}`);
  return price;
}

/** Map a DreamDEX market base (WBTC/WETH) to the feed asset it tracks. */
export function baseToFeedAsset(base: string): FeedAsset | null {
  const b = (base ?? "").toUpperCase();
  if (b === "WBTC" || b === "BTC") return "BTC";
  if (b === "WETH" || b === "ETH") return "ETH";
  return null;
}

/** OFFSET_SEC retry window so transient timeouts decay rather than hard-fail. */
export const FEED_ATTEMPTS = 2;
