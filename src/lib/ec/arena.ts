import type { MatchDoc } from "@/db/models/Match";
import { findArenaFloor, readArenaPrice, type EcArenaMarket } from "./executor";

type LoosenedMatch = Pick<MatchDoc, "_id"> & {
  priceModel?: MatchDoc["priceModel"] & { arena?: EcArenaMarket; arenaOpen?: number };
};

/**
 * Resolve the Event-Contract arena floor a match's rounds run inside. Reuses
 * the arena already pinned on the match while it is still live, otherwise
 * discovers the freshest active BTC/ETH binary window via `findArenaFloor` and
 * pins it on the match. Returns null when no live EC floor exists right now
 * (the arena between windows / pre-resolution) — the caller falls back to an
 * honest FLAT no-op rather than faking a price.
 */
export async function ecArenaForMatch(
  match: LoosenedMatch,
  asset: "BTC" | "ETH",
  opts: { preferBook?: boolean } = {},
): Promise<EcArenaMarket | null> {
  const pinned = match.priceModel?.arena;
  const now = Math.floor(Date.now() / 1000);
  if (pinned?.marketId && pinned.expiry > now) {
    return pinned;
  }
  try {
    // Prefer a window with >=30s left (stable, won't roll mid-match), but FALL
    // BACK to any live window if none qualifies. Requiring 30s+ exclusively made
    // rounds between window rolls throw "no live EC arena floor" -> recorded as
    // FLAT no-ops -> every match degenerated to a 0-0 draw. A window with even a
    // few seconds left is a valid, honest reference.
    // Rounds resolve off the live order book, so prefer a window with real
    // two-sided depth (the venue's liquid windows) over an empty real-strike
    // book — the former actually moves, the latter degenerates every round to
    // a FLAT no-op. Find a window with >=30s left (stable, won't roll mid-
    // match) but FALL BACK to any live window if none qualifies. Requiring 30s+
    // exclusively made rounds between window rolls throw "no live EC arena
    // floor" -> recorded as FLAT no-ops -> every match degenerated to a 0-0
    // draw. A window with even a few seconds left is a valid, honest reference.
    let arena = await findArenaFloor(asset, 30, opts);
    if (!arena) arena = await findArenaFloor(asset, 0, opts);
    if (!arena) return null;
    // Only re-anchor if a fresh arena differs from the pinned one. The arena + its
    // window-open YES seed must be STABLE across the whole window so that a single
    // position (one directional call, one stake) cleanly spans multiple matches —
    // and so every round resolves against the SAME real reference instead of the
    // previous round's near-identical read (the source of all-FLAT 0-0 draws).
    // round's near-identical read (the source of all-FLAT 0-0 draws).
    const same = pinned?.marketId === arena.marketId;
    const set: Record<string, unknown> = { "priceModel.arena": arena };
    if (!same && !(match.priceModel?.arenaOpen && match.priceModel.arenaOpen > 0)) {
      set["priceModel.arenaOpen"] = await readArenaPrice(arena).then((q) =>
        q.yesPrice && q.yesPrice > 0 ? q.yesPrice : 0,
      ).catch(() => 0);
    }
    await import("@/db/models/Match").then(({ Match }) =>
      Match.updateOne({ _id: match._id }, { $set: set }),
    ).catch(() => {});
    return arena;
  } catch (err) {
    console.error(`[predict] arena floor discovery failed for ${asset}`, err);
    return null;
  }
}
