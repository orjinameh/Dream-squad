import { connectToDatabase } from "@/db/connect";
import { User } from "@/db/models/User";
import { Batch } from "@/db/models/Batch";
import { Trade } from "@/db/models/Trade";
import { getMarket, amountMeetsMinimum } from "@/lib/markets";
import { normalizeAddress } from "@/lib/addresses";
import { createSyndicateSchema } from "@/lib/validation";
import { generateBatchId, jsonError } from "@/lib/syndicates";
import { checkAccountWarmup } from "@/lib/warmup";
import { aggregateAssets, type ResolvedAsset } from "@/lib/tokens";
import { APPROX_PRICES } from "@/lib/config";

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "body must be JSON");
  }

  const parsed = createSyndicateSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, `validation failed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const input = parsed.data;

  const market = getMarket(input.market);
  if (!market) return jsonError(400, `unknown market: ${input.market}`);

  // Resolve the final amount: multi-asset aggregation or legacy single amount.
  let finalAmount: number;
  let resolvedAssets: ResolvedAsset[];

  if (input.assets && input.assets.length > 0) {
    const marketPrice = APPROX_PRICES[input.market] ?? 1;
    const { totalBaseAmount, resolved } = aggregateAssets(
      input.assets,
      market.baseDecimals,
      marketPrice,
    );
    finalAmount = totalBaseAmount;
    resolvedAssets = resolved;
  } else {
    finalAmount = input.amount;
    resolvedAssets = [{ symbol: market.symbol.split(":")[0], amount: input.amount, usdValue: input.amount * (APPROX_PRICES[input.market] ?? 1) }];
  }

  // Pool minimums are enforced HERE, before an intent is ever saved -- the pool
  // reverts QuantityBelowMinimum at execution time and the sweep would eat gas.
  if (!amountMeetsMinimum(market, finalAmount)) {
    return jsonError(
      400,
      `amount ${finalAmount} is below the pool minimum ${market.minAmount} ${market.symbol} (lot ${market.lotSize})`,
    );
  }

  const creatorAddress = normalizeAddress(input.creatorAddress);

  try {
    await connectToDatabase();

    await User.findByIdAndUpdate(
      creatorAddress,
      { $setOnInsert: { _id: creatorAddress, operatorAuthorized: false, vaultInitialized: false } },
      { upsert: true },
    );

    const now = new Date();
    const closesAt = new Date(now.getTime() + input.durationSeconds * 1000);
    const batchId = generateBatchId(market.symbol);

    await Batch.create({
      _id: batchId,
      creatorAddress,
      market: market.symbol,
      direction: input.direction,
      status: "OPEN",
      opensAt: now,
      closesAt,
      totalPool: 0,
      createdAt: now,
    });

    const trade = await Trade.create({
      batchId,
      userAddress: creatorAddress,
      amount: finalAmount,
      assets: resolvedAssets,
      dustSweep: input.dustSweep ?? false,
      status: "PENDING",
    });
    await Batch.updateOne({ _id: batchId }, { $inc: { totalPool: finalAmount } });

    const warmup = await checkAccountWarmup(creatorAddress).catch(() => null);

    return Response.json(
      {
        batchId,
        closesAt: closesAt.toISOString(),
        tradeId: trade._id,
        totalPool: finalAmount,
        assets: resolvedAssets,
        walletReady: warmup ? warmup.warm : null,
      },
      { status: 201 },
    );
  } catch (err) {
    console.error("create failed", err);
    return jsonError(500, "failed to create syndicate");
  }
}
