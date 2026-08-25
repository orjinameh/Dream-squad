import { connectToDatabase } from "@/db/connect";
import { User } from "@/db/models/User";
import { Batch } from "@/db/models/Batch";
import { Trade } from "@/db/models/Trade";
import { getMarket, amountMeetsMinimum } from "@/lib/markets";
import { normalizeAddress } from "@/lib/addresses";
import { createSyndicateSchema } from "@/lib/validation";
import { generateBatchId, jsonError } from "@/lib/syndicates";
import { checkAccountWarmup } from "@/lib/warmup";

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

  // Pool minimums are enforced HERE, before an intent is ever saved -- the pool
  // reverts QuantityBelowMinimum at execution time and the sweep would eat gas.
  if (!amountMeetsMinimum(market, input.amount)) {
    return jsonError(
      400,
      `amount ${input.amount} is below the pool minimum ${market.minAmount} ${market.symbol} (lot ${market.lotSize})`,
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
      amount: input.amount,
      status: "PENDING",
    });
    await Batch.updateOne({ _id: batchId }, { $inc: { totalPool: input.amount } });

    // Non-blocking warmup hint (Phase 1 learning): a cold wallet cannot even
    // pay gas for the one-time operator grant it must sign after joining.
    const warmup = await checkAccountWarmup(creatorAddress).catch(() => null);

    return Response.json(
      {
        batchId,
        closesAt: closesAt.toISOString(),
        tradeId: trade._id,
        totalPool: input.amount,
        walletReady: warmup ? warmup.warm : null,
      },
      { status: 201 },
    );
  } catch (err) {
    console.error("create failed", err);
    return jsonError(500, "failed to create syndicate");
  }
}
