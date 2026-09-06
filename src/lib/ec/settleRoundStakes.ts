import { connectToDatabase } from "@/db/connect";
import { Match } from "@/db/models/Match";
import { readArenaSettlement } from "./executor";
import { redeemWinningStake } from "./staker";

/**
 * Settle the per-round DreamDEX stakes for every match whose pinned arena has
 * RESOLVED on-chain. Idempotent per checkpoint (`stakeSettlement` is written
 * once, guarded by an `$exists: false` filter so a re-sweep never double-settles
 * or double-redeems).
 *
 *   - WON   → the player's outcome tokens are redeemed 1:1; net = qty − cost.
 *   - VOIDED→ the venue refunds both sides 0.5; net = qty/2 − cost.
 *   - LOST  → tokens are worthless; net = −cost.
 *
 * Runs from the worker every ~15s AND lazily whenever stake history is fetched,
 * so a round's settlement is surfaced (and money collected) without waiting for
 * the next cron tick.
 */
export async function settleRoundStakes(skipMatchIds?: string[]): Promise<number> {
  await connectToDatabase();
  const query: Record<string, unknown> = {
    status: { $in: ["ACTIVE", "COMPLETED"] },
    "priceModel.checkpoints.stakeTxHash": { $exists: true },
    "priceModel.checkpoints.stakeSettlement": { $exists: false },
  };
  if (skipMatchIds?.length) query._id = { $nin: skipMatchIds };

  const matches = await Match.find(query).lean();
  let settled = 0;

  for (const match of matches) {
    const checkpoints = match.priceModel?.checkpoints ?? [];
    for (let i = 0; i < checkpoints.length; i++) {
      const cp = checkpoints[i];
      if (!cp?.arena?.marketId || !cp.stakeTxHash || cp.stakeSettlement) continue;
      const qty = (() => {
        try { return cp.stakeQty ? BigInt(cp.stakeQty) : null; }
        catch { return null; }
      })();
      if (qty == null || qty <= 0n) continue;
      // Cost is required to compute honest net P&L — a missing cost would
      // fabricate `net = qty` free money. Skip until the stake write lands.
      if (!cp.stakeCostRaw) continue;
      let cost: bigint;
      try { cost = BigInt(cp.stakeCostRaw); }
      catch { continue; }

      const arena = {
        marketId: cp.arena.marketId,
        pool: cp.arena.pool as `0x${string}`,
        symbol: cp.arena.symbol,
        expiry: cp.arena.expiry ?? Math.floor(Date.now() / 1000),
      };
      const st = await readArenaSettlement(arena).catch(() => null);
      if (!st?.isResolved) continue;

      // Never invent a side: a missing stakeSide + missing round prediction
      // means we cannot know won/lost — defaulting to UP would invert DOWN wins.
      const sideRaw = cp.stakeSide ?? (match.rounds?.[i]?.playerPrediction ?? null);
      if (sideRaw !== "UP" && sideRaw !== "DOWN") continue;
      const side = sideRaw;
      const upWon = st.winningOutcome === 0;
      const voided = st.isVoided === true;
      const won = !voided && (side === "UP" ? upWon : !upWon);

      // Won or refunded → redeem the player's side. The win side redeems 1:1;
      // a voided market refunds 0.5 per token whichever side you hold.
      // Claim the settlement slot FIRST so concurrent workers can't double-redeem.
      const claimed = await Match.updateOne(
        { _id: match._id, [`priceModel.checkpoints.${i}.stakeSettlement`]: { $exists: false } },
        { $set: { [`priceModel.checkpoints.${i}.stakeSettlement`]: { won: false, voided: false, netPnlRaw: "0", settledAt: new Date().toISOString(), settling: true } } },
      );
      if (claimed.modifiedCount !== 1) continue;
      let redeemTxHash: string | undefined;
      if (won || voided) {
        const outcomeIdx = side === "UP" ? 0 : 1;
        const r = await redeemWinningStake(arena.marketId as `0x${string}`, outcomeIdx, qty).catch(() => null);
        redeemTxHash = r?.txHash ?? undefined;
      }

      const netPnlRaw = won ? qty - cost : voided ? qty / 2n - cost : -cost;
      const settledAt = new Date().toISOString();

      // Finalize (overwrite the settling placeholder).
      const res = await Match.updateOne(
        { _id: match._id },
        {
          $set: {
            [`priceModel.checkpoints.${i}.stakeSettlement`]: {
              won,
              voided,
              netPnlRaw: netPnlRaw.toString(),
              ...(redeemTxHash ? { redeemTxHash } : {}),
              settledAt,
            },
          },
        },
      );
      if (res.modifiedCount === 1) settled += 1;
    }
  }
  return settled;
}