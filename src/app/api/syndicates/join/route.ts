import { connectToDatabase } from "@/db/connect";
import { User } from "@/db/models/User";
import { Batch } from "@/db/models/Batch";
import { Trade } from "@/db/models/Trade";
import { getMarket, amountMeetsMinimum } from "@/lib/markets";
import { normalizeAddress } from "@/lib/addresses";
import { joinSyndicateSchema } from "@/lib/validation";
import { jsonError } from "@/lib/syndicates";
import { aggregateAssets, type ResolvedAsset } from "@/lib/tokens";
import { APPROX_PRICES } from "@/lib/config";

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "body must be JSON");
  }

  const parsed = joinSyndicateSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, `validation failed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const input = parsed.data;

  try {
    await connectToDatabase();

    const batch = await Batch.findById(input.batchId);
    if (!batch) return jsonError(404, `syndicate not found: ${input.batchId}`);
    if (batch.status !== "OPEN") return jsonError(409, `syndicate is ${batch.status}, no longer accepting pledges`);
    if (batch.closesAt.getTime() <= Date.now()) {
      return jsonError(409, "syndicate timer has expired");
    }

    const market = getMarket(batch.market);
    if (!market) return jsonError(500, `batch references unknown market: ${batch.market}`);

    // Resolve the final amount: multi-asset aggregation or legacy single amount.
    let finalAmount: number;
    let resolvedAssets: ResolvedAsset[];

    if (input.assets && input.assets.length > 0) {
      const marketPrice = APPROX_PRICES[batch.market] ?? 1;
      const { totalBaseAmount, resolved } = aggregateAssets(
        input.assets,
        market.baseDecimals,
        marketPrice,
      );
      finalAmount = totalBaseAmount;
      resolvedAssets = resolved;
    } else {
      finalAmount = input.amount;
      resolvedAssets = [{ symbol: batch.market.split(":")[0], amount: input.amount, usdValue: input.amount * (APPROX_PRICES[batch.market] ?? 1) }];
    }

    if (!amountMeetsMinimum(market, finalAmount)) {
      return jsonError(
        400,
        `amount ${finalAmount} is below the pool minimum ${market.minAmount} ${market.symbol} (lot ${market.lotSize})`,
      );
    }

    const userAddress = normalizeAddress(input.userAddress);
    await User.findByIdAndUpdate(
      userAddress,
      { $setOnInsert: { _id: userAddress, operatorAuthorized: false, vaultInitialized: false } },
      { upsert: true },
    );

    const reservation = await Batch.updateOne(
      { _id: batch._id, status: "OPEN", closesAt: { $gt: new Date() } },
      { $inc: { totalPool: finalAmount } },
    );
    if (reservation.modifiedCount === 0) {
      return jsonError(409, "syndicate just closed or expired");
    }

    let tradeId: string;
    try {
      const trade = await Trade.create({
        batchId: batch._id,
        userAddress,
        amount: finalAmount,
        assets: resolvedAssets,
        dustSweep: input.dustSweep ?? false,
        status: "PENDING",
      });
      tradeId = trade._id;
    } catch (e) {
      await Batch.updateOne({ _id: batch._id }, { $inc: { totalPool: -finalAmount } });
      const dup = (e as { code?: number }).code === 11000;
      return jsonError(dup ? 409 : 500, dup ? "wallet already pledged to this syndicate" : "failed to record pledge");
    }

    const updated = await Batch.findById(batch._id).select("totalPool").lean();
    return Response.json({ tradeId, totalPool: updated?.totalPool ?? batch.totalPool + finalAmount, assets: resolvedAssets }, { status: 201 });
  } catch (err) {
    console.error("join failed", err);
    return jsonError(500, "failed to join syndicate");
  }
}
