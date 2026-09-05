import { connectToDatabase } from "@/db/connect";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { isAddress, formatUnits } from "viem";
import { EC_COLLATERAL_DECIMALS } from "@/lib/ec/config";
import { Match } from "@/db/models/Match";
import { EcPosition } from "@/db/models/EcPosition";
import { settleRoundStakes } from "@/lib/ec/settleRoundStakes";
import { reconcilePositions } from "@/lib/ec/position";

/**
 * GET /api/stakes?address=0x… — the wallet's REAL on-chain stake history.
 *
 * The financial layer used to be a single one-shot EC escrow position. It is
 * now per-round: every round of every match places the player's actual
 * BUY_YES/BUY_NO market order on a real DreamDEX binary window (relayed by the
 * operator). This endpoint:
 *
 *   - lazily settles any round whose pinned window has lapsed (idempotent, also
 *     runs on the worker), so a row already WON/LOST with its PnL + redeem tx;
 *   - returns each round's placement (tx hash, size, cost) with a Shannon
 *     explorer link, plus its arena window;
 *   - still lists legacy one-shot escrow positions (outcome + tx links) so
 *     nothing older disappears.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("address") ?? "";
  if (!isAddress(raw)) return jsonError(400, "address query param required");
  const lower = normalizeAddress(raw).toLowerCase();
  try {
    await connectToDatabase();

    // Settle this wallet's resolved rounds + positions inline (the worker also
    // runs both on a 15s sweep; this keeps the screen fresh without waiting).
    await settleRoundStakes().catch(() => {});
    await reconcilePositions({ address: lower }).catch(() => {});

    const matches = await Match.find({
      playerAddress: lower,
      "priceModel.checkpoints.stakeTxHash": { $exists: true },
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const roundStakes = [];
    for (const m of matches) {
      const cps = (m.priceModel?.checkpoints ?? []) as {
        roundNum?: number;
        stakeTxHash?: string;
        stakeSide?: "UP" | "DOWN";
        stakeQty?: string;
        stakeCostRaw?: string;
        stakeSettlement?: {
          won?: boolean;
          voided?: boolean;
          netPnlRaw?: string;
          redeemTxHash?: string;
          settledAt?: string;
        };
        arena?: { symbol?: string; marketId?: string; pool?: string; expiry?: number };
      }[];
      for (let i = 0; i < cps.length; i++) {
        const cp = cps[i];
        if (!cp?.stakeTxHash) continue;
        const st = cp.stakeSettlement;
        const matchedRound = m.rounds?.[i];
        const qtyRaw = cp.stakeQty ? BigInt(cp.stakeQty) : null;
        const costRaw = cp.stakeCostRaw ?? null;
        roundStakes.push({
          kind: "round",
          id: `${m._id}#${i}`,
          matchId: m._id,
          roundNum: i + 1,
          direction: cp.stakeSide ?? matchedRound?.playerPrediction ?? "UP",
          market: m.predictionAsset ?? m.executionConfig?.marketSymbol ?? "BTC",
          amount: m.playerAmountPerRound ?? 1,
          status: st ? (st.won ? "WON" : "LOST") : "ACTIVE",
          voided: st?.voided ?? false,
          stakeTxHash: cp.stakeTxHash,
          qtyFormatted: qtyRaw ? formatUnits(qtyRaw, EC_COLLATERAL_DECIMALS) : null,
          costFormatted: costRaw ? formatUnits(BigInt(costRaw), EC_COLLATERAL_DECIMALS) : null,
          netPnlFormatted: st?.netPnlRaw ? formatUnits(BigInt(st.netPnlRaw), EC_COLLATERAL_DECIMALS) : null,
          redeemTxHash: st?.redeemTxHash ?? null,
          arena: cp.arena
            ? {
                symbol: cp.arena.symbol ?? null,
                marketId: cp.arena.marketId ?? null,
                pool: cp.arena.pool ?? null,
                expiry: cp.arena.expiry ?? null,
              }
            : null,
          createdAt: m.createdAt?.toISOString() ?? null,
          settledAt: st?.settledAt ?? null,
        });
      }
    }

    // Legacy one-shot escrow positions (the original money layer). New per-round
    // matches no longer create these, but existing ones stay visible + resolved.
    const positions = await EcPosition.find({ address: lower }).sort({ createdAt: -1 }).limit(50).lean();
    const positionStakes = positions.map((p) => ({
      kind: "position" as const,
      id: String(p._id),
      direction: p.direction,
      market: p.market,
      amount: p.amount,
      status: p.status,
      stakeTxHash: p.stakeTxHash ?? null,
      arenaSymbol: (p.arena as { symbol?: string } | undefined)?.symbol ?? null,
      createdAt: p.createdAt?.toISOString() ?? null,
    }));

    return Response.json({ roundStakes, positionStakes });
  } catch (err) {
    console.error("stake history failed", err);
    return jsonError(500, "failed to load stake history");
  }
}