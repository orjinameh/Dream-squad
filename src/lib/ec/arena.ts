import type { MatchDoc } from "@/db/models/Match";
import { findArenaFloor, readArenaPrice, type ArenaRef, type EcArenaMarket } from "./executor";

type LoosenedMatch = Pick<MatchDoc, "_id"> & {
  priceModel?: MatchDoc["priceModel"] & { arena?: ArenaRef; arenaOpen?: number };
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
): Promise<ArenaRef | null> {
  const pinned = match.priceModel?.arena;
  const now = Math.floor(Date.now() / 1000);
  if (pinned?.marketId && pinned.expiry > now) {
    return pinned;
  }
  try {
    // Prefer the SOONEST window that still has >=15s left (enough to place the
    // stake before it expires): the round's real result lands fastest when its
    // window closes quickly, keeping matches ~10-40s per round instead of a
    // full venue window (~60-150s). Falls back to any live window otherwise.
    let arena = await findArenaFloor(asset, 15, opts);
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

/**
 * Per-round arena pin. A round's real stake and its resolution MUST reference the
 * SAME window, and every round should fight its OWN window (one resolution per
 * round — reusing one market for several rounds would freeze every following
 * round on the first resolution). Prefers the arena pinned for this specific
 * round while it is still live; otherwise discovers the freshest window and pins
 * it on the round's checkpoint too.
 */
export async function ecArenaForRound(
  match: LoosenedMatch,
  asset: "BTC" | "ETH",
  roundIndex: number,
  opts: { preferBook?: boolean } = {},
): Promise<ArenaRef | null> {
  const cp = match.priceModel?.checkpoints?.[roundIndex];
  const now = Math.floor(Date.now() / 1000);
  if (cp?.arena?.marketId && Number(cp.arena.expiry) > now) return cp.arena;
  const arena = await ecArenaForMatch(match, asset, opts);
  if (!arena) return null;
  const pm = match.priceModel ?? ({} as NonNullable<LoosenedMatch["priceModel"]>);
  match.priceModel = pm;
  pm.checkpoints = pm.checkpoints ?? [];
  const pinned = pm.checkpoints[roundIndex] ?? (pm.checkpoints[roundIndex] = { roundNum: roundIndex + 1, startPrice: 0, endPrice: 0, prices: [], actual: "FLAT" });
  pinned.arena = arena;
  await import("@/db/models/Match").then(({ Match }) =>
    Match.updateOne({ _id: match._id }, { $set: { [`priceModel.checkpoints.${roundIndex}.arena`]: arena } }),
  ).catch(() => {});
  return arena;
}
