import { connectToDatabase } from "@/db/connect";
import { Batch, type BatchDoc } from "@/db/models/Batch";
import { Trade, type TradeDoc } from "@/db/models/Trade";
import { maskAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";

interface TradeRow {
  user: string;
  amount: number;
  status: string;
  txHash?: string;
}

function scrubTrade(t: TradeDoc): TradeRow {
  const row: TradeRow = { user: maskAddress(t.userAddress), amount: t.amount, status: t.status };
  if (t.txHash) row.txHash = t.txHash;
  return row;
}

/**
 * Public lobby/invite payload. Wallet addresses are masked (0x12...ab) --
 * full addresses are PII-adjacent and never needed by the UI.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;

  try {
    await connectToDatabase();

    const batch = await Batch.findById(id).lean<BatchDoc | null>();
    if (!batch) return jsonError(404, `syndicate not found: ${id}`);

    const trades = await Trade.find({ batchId: id }).sort({ createdAt: 1 }).lean<TradeDoc[]>();
    const now = Date.now();
    const remainingMs = Math.max(0, batch.closesAt.getTime() - now);

    const payload: Record<string, unknown> = {
      batchId: batch._id,
      status: batch.status,
      market: batch.market,
      direction: batch.direction,
      creator: maskAddress(batch.creatorAddress),
      totalPool: batch.totalPool,
      participants: trades.length,
      closesAt: batch.closesAt.toISOString(),
      timeRemainingMs: remainingMs,
      expired: remainingMs === 0,
      pledges: trades.map(scrubTrade),
    };

    // Execution receipt for the Live Lobby success banner.
    if (batch.status === "EXECUTED" || batch.status === "FAILED") {
      payload.receipt = trades.map((t) => ({
        user: maskAddress(t.userAddress),
        status: t.status,
        txHash: t.txHash ?? null,
        errorMessage: t.errorMessage ?? null,
        executedAt: t.executedAt?.toISOString() ?? null,
      }));
    }

    return Response.json(payload);
  } catch (err) {
    console.error("status failed", err);
    return jsonError(500, "failed to fetch syndicate");
  }
}
