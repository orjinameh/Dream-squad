import { connectToDatabase } from "@/db/connect";
import { randomUUID } from "node:crypto";
import { Match, ROUND_TIMINGS } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { buildMatchPriceModel } from "@/lib/prices";
import { baseToFeedAsset, fetchSpotAsset } from "@/lib/price-feed";
import { getMarket } from "@/lib/markets";
import { openBotMatchEscrow } from "@/lib/ec/settleMatch";
import { z } from "zod";
import { isAddress } from "viem";

const createMatchSchema = z.object({
  playerAddress: z.string().refine((v) => isAddress(v), "invalid address"),
  playerChar: z.string().min(1),
  rivalName: z.string().min(1),
  rivalChar: z.string().min(1),
  mode: z.string().min(1),
  totalRounds: z.number().int().positive(),
  opponentType: z.enum(["bot", "player"]).optional(),
  botDifficulty: z.enum(["easy", "normal", "hard"]).optional(),
  predictionAsset: z.string().optional(),
  amountPerRound: z.number().positive().optional(),
  marketSymbol: z.string().min(1).optional(),
});

// The rival gets its own independent stake, generated so the two players can
// trade different amounts. For a real PvP opponent their stake is overridden
// when they join.
function generateRivalStake(): number {
  const options = [1, 2, 5, 10];
  return options[Math.floor(Math.random() * options.length)];
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError(400, "body must be JSON"); }

  const parsed = createMatchSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, `validation failed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const input = parsed.data;

  try {
    await connectToDatabase();
    const address = normalizeAddress(input.playerAddress);

    // ENFORCE ONE ACTIVE MATCH PER WALLET
    const activeMatch = await Match.findOne({
      $or: [{ playerAddress: address }, { player2Address: address }],
      status: "ACTIVE",
    }).lean();

    if (activeMatch) {
      return jsonError(409, "already in an active match");
    }

    const now = new Date();
    const deadline = new Date(now.getTime() + ROUND_TIMINGS.ROUND_DURATION_MS + ROUND_TIMINGS.LOCK_MS); // lock window before round 1

    const asset = input.predictionAsset ?? "BTC";
    const matchId = randomUUID();
    // Resolve the on-chain market the player chose. Defaults to SOMI:tUSDC (the
    // only live pool today). A picked market that isn't in the registry falls
    // back to the default so we never persist a non-executable pool.
    const marketSymbol = input.marketSymbol && getMarket(input.marketSymbol)
      ? input.marketSymbol
      : "SOMI:tUSDC";
    // Real entry price from the DreamDEX oracle (no synthetic model). If the
    // feed is unreachable at creation the match still opens with entry 0 and
    // the first round anchors on a live fetch (see predict resolution).
    let entryPrice = 0;
    const feedAsset = baseToFeedAsset(asset);
    if (feedAsset) {
      try { entryPrice = await fetchSpotAsset(feedAsset); } catch {}
    }
    // ONE continuous real market for the whole match: the observed entry price
    // plus live-resolved round checkpoints (appended by the predict endpoint).
    const priceModel = buildMatchPriceModel(asset, entryPrice);

    const isBot = input.opponentType !== "player";
    const match = await Match.create({
      _id: matchId,
      playerAddress: address,
      playerChar: input.playerChar,
      rivalName: input.rivalName,
      rivalChar: input.rivalChar,
      mode: input.mode,
      totalRounds: input.totalRounds,
      currentRound: 1,
      roundPhase: "ACTIVE",
      roundStartTime: now,
      roundDeadline: deadline,
      status: "ACTIVE",
      opponentType: isBot ? "bot" : "player",
      botDifficulty: input.botDifficulty ?? "normal",
      predictionAsset: asset,
      predictionQuestion: `WILL ${asset} GO UP OR DOWN?`,
      priceModel,
      marketId: marketSymbol,
      executionConfig: {
        marketSymbol,
        amountPerRound: input.amountPerRound ?? 1,
      },
      // Per-player independent trade amount. The creating player's chosen
      // stake drives their on-chain order + P&L. The rival gets its own stake
      // (generated for the bot; a real PvP opponent's stake is set when they
      // join). Neither affects the other's P&L.
      playerAmountPerRound: input.amountPerRound ?? 1,
      rivalAmountPerRound: generateRivalStake(),
    });

    // Bot matches: open a SOLO escrow (player vs house) so the player can pledge
    // real tUSDC when the bot fight starts. Best-effort — a failure is reconciled
    // by the settlement worker; never blocks match creation.
    if (isBot) {
      void openBotMatchEscrow(matchId, address).catch(() => {});
    }

    return Response.json({
      matchId: match._id,
      serverTime: now.toISOString(),
      roundStartTime: now.toISOString(),
      roundDeadline: deadline.toISOString(),
    }, { status: 201 });
  } catch (err) {
    console.error("create match failed", err);
    return jsonError(500, "failed to create match");
  }
}
