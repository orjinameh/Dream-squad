import { connectToDatabase } from "@/db/connect";
import { Match, type RoundPhase, type StatsProcessedStatus } from "@/db/models/Match";
import { PlayerStats } from "@/db/models/PlayerStats";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { generateRoundSeries } from "@/lib/prices";
import { getPvpWinPoints } from "@/lib/rank";

export const dynamic = "force-dynamic";

const MAX_HP = 100;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const matchId = url.searchParams.get("matchId");
  const viewerAddress = url.searchParams.get("address");

  if (!matchId) return jsonError(400, "matchId required");

  try {
    await connectToDatabase();
    const match = await Match.findById(matchId);
    if (!match) return jsonError(404, "match not found");

    const now = new Date();
    const isPvP = match.opponentType === "player";
    const isViewerP2 = !!(isPvP && viewerAddress && match.player2Address && normalizeAddress(viewerAddress) === normalizeAddress(match.player2Address));

    // Auto-resolve expired bot rounds (server-authoritative)
    if (match.status === "ACTIVE" && match.opponentType === "bot" && match.roundPhase === "ACTIVE" && now.getTime() > match.roundDeadline.getTime()) {
      // Check if player predicted
      if (!match.playerPrediction) {
        // No prediction submitted — mark as draw/no-contest for this round
        const series = generateRoundSeries(`${matchId}:${match.currentRound}`, match.predictionAsset ?? "BTC");
        const roundRecord = {
          roundNum: match.currentRound,
          playerPrediction: null,
          rivalPrediction: null,
          actual: series.actual,
          playerCorrect: false,
          rivalCorrect: false,
          roundWinner: "draw" as const,
          damage: 0,
          playerDamage: 0,
          rivalDamage: 0,
          isCritical: false,
          knockout: false,
          startPrice: series.startPrice,
          endPrice: series.endPrice,
          prices: series.prices,
          asset: series.asset,
          playerPnL: 0,
          rivalPnL: 0,
          resolvedAt: now,
        };

        const isLastRound = match.currentRound >= match.totalRounds;
        const nextDeadline = new Date(now.getTime() + 1000);

        await Match.findByIdAndUpdate(matchId, {
          $push: { rounds: roundRecord },
          $set: {
            roundPhase: isLastRound ? "REVEALED" : "ACTIVE",
            status: isLastRound ? "COMPLETED" : "ACTIVE",
            ...(isLastRound ? { completedAt: now, winner: "draw", statsProcessed: "PENDING" as StatsProcessedStatus } : {
              currentRound: match.currentRound + 1,
              playerPrediction: null,
              rivalPrediction: null,
              roundStartTime: now,
              roundDeadline: nextDeadline,
            }),
          },
        });

        const updated = await Match.findById(matchId);
        if (updated && isLastRound) {
          await updateStatsForAutoResolved(updated, now);
        }
        if (updated) {
          return Response.json(buildState(updated, now, isViewerP2, viewerAddress));
        }
      }
      // If player predicted but predict endpoint hasn't resolved yet,
      // the predict endpoint will handle it. Return current state.
    }

    return Response.json(buildState(match, now, isViewerP2, viewerAddress));
  } catch (err) {
    console.error("state failed", err);
    return jsonError(500, "failed to fetch state");
  }
}

async function updateStatsForAutoResolved(match: any, now: Date) {
  const matchId = match._id;
  const addr = normalizeAddress(match.playerAddress);

  const totalWins = match.winner === "player" ? 1 : 0;
  const totalLosses = match.winner === "rival" ? 1 : 0;
  const totalDraws = match.winner === "draw" ? 1 : 0;
  const isBot = match.opponentType === "bot";
  const rankDelta = getPvpWinPoints(totalWins === 1, totalDraws === 1);

  await PlayerStats.findOneAndUpdate(
    { _id: addr, processedMatches: { $ne: matchId } },
    {
      $setOnInsert: { address: addr },
      $inc: {
        totalWins, totalLosses, totalDraws,
        totalMatches: 1, totalRounds: match.totalRounds,
        ...(isBot
          ? { botWins: totalWins, botLosses: totalLosses, botDraws: totalDraws, botMatches: 1, botRounds: match.totalRounds }
          : { pvpWins: totalWins, pvpLosses: totalLosses, pvpDraws: totalDraws, pvpMatches: 1, pvpRounds: match.totalRounds }),
        rankPoints: rankDelta,
      },
      $addToSet: { processedMatches: matchId },
      $set: { lastPlayedAt: now, favoriteChar: match.playerChar },
    },
    { upsert: true },
  );
}

function buildState(match: any, serverTime: Date, isViewerP2: boolean, viewerAddress: string | null) {
  const rounds = (match.rounds ?? []).map((r: any) => ({
    roundNum: r.roundNum,
    playerPrediction: isViewerP2 ? r.rivalPrediction : r.playerPrediction,
    rivalPrediction: isViewerP2 ? r.playerPrediction : r.rivalPrediction,
    actual: r.actual,
    playerCorrect: isViewerP2 ? r.rivalCorrect : r.playerCorrect,
    rivalCorrect: isViewerP2 ? r.playerCorrect : r.rivalCorrect,
    // Server-authoritative combat data
    roundWinner: r.roundWinner,
    damage: r.damage,
    playerDamage: isViewerP2 ? r.rivalDamage : r.playerDamage,
    rivalDamage: isViewerP2 ? r.playerDamage : r.rivalDamage,
    isCritical: r.isCritical,
    knockout: r.knockout,
    // Coherent market series
    startPrice: r.startPrice,
    endPrice: r.endPrice,
    prices: r.prices,
    asset: r.asset,
    // Trading P&L
    playerPnL: isViewerP2 ? r.rivalPnL : r.playerPnL,
    rivalPnL: isViewerP2 ? r.playerPnL : r.rivalPnL,
    playerExecution: r.playerExecution,
    rivalExecution: r.rivalExecution,
  }));

  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : undefined;

  // Perspective-safe fields
  const myScore = isViewerP2 ? match.rivalScore : match.playerScore;
  const theirScore = isViewerP2 ? match.playerScore : match.rivalScore;
  const myPred = isViewerP2 ? match.rivalPrediction : match.playerPrediction;
  const theirPred = isViewerP2 ? match.playerPrediction : match.rivalPrediction;
  const myChar = isViewerP2 ? match.player2Char || match.rivalChar : match.playerChar;
  const theirChar = isViewerP2 ? match.playerChar : match.player2Char || match.rivalChar;
  const myHP = isViewerP2 ? match.rivalHP : match.playerHP;
  const theirHP = isViewerP2 ? match.playerHP : match.rivalHP;
  const myStreak = isViewerP2 ? match.rivalStreak : match.playerStreak;
  const theirStreak = isViewerP2 ? match.playerStreak : match.rivalStreak;

  // Deterministic series for the current active round (chart + resolution agree).
  const asset = match.predictionAsset ?? "BTC";
  const series = match.roundPhase === "ACTIVE" && match.status === "ACTIVE"
    ? generateRoundSeries(`${match._id}:${match.currentRound}`, asset)
    : undefined;

  // Running balances (STT).
  const startMe = isViewerP2 ? (match.rivalStartBalance ?? 100) : (match.playerStartBalance ?? 100);
  const startThem = isViewerP2 ? (match.playerStartBalance ?? 100) : (match.rivalStartBalance ?? 100);
  const mePnl = (match.rounds ?? []).reduce((s: number, r: any) => s + (isViewerP2 ? (r.rivalPnL ?? 0) : (r.playerPnL ?? 0)), 0);
  const themPnl = (match.rounds ?? []).reduce((s: number, r: any) => s + (isViewerP2 ? (r.playerPnL ?? 0) : (r.rivalPnL ?? 0)), 0);

  return {
    matchId: match._id,
    status: match.status,
    mode: match.mode,
    totalRounds: match.totalRounds,
    currentRound: match.currentRound,
    roundPhase: match.roundPhase,
    roundStartTime: match.roundStartTime?.toISOString?.() ?? match.roundStartTime,
    roundDeadline: match.roundDeadline?.toISOString?.() ?? match.roundDeadline,
    serverTime: serverTime.toISOString(),
    playerScore: myScore,
    rivalScore: theirScore,
    playerPrediction: myPred ?? null,
    rivalPrediction: theirPred ?? null,
    rounds,
    winner: match.winner ?? "player",
    playerChar: myChar,
    rivalChar: theirChar,
    rivalName: match.rivalName,
    opponentType: match.opponentType ?? "bot",
    hasOpponent: !!match.player2Address,
    player2Char: match.player2Char,
    player1Ready: match.player1Ready ?? true,
    player2Ready: match.player2Ready ?? false,
    predictionAsset: match.predictionAsset ?? "BTC",
    predictionQuestion: match.predictionQuestion ?? "WILL BTC GO UP OR DOWN?",
    botDifficulty: match.botDifficulty ?? "normal",
    // Server-authoritative combat
    playerHP: myHP,
    rivalHP: theirHP,
    playerStreak: myStreak,
    rivalStreak: theirStreak,
    // Coherent market series
    market: series ? {
      asset: series.asset,
      startPrice: series.startPrice,
      endPrice: series.endPrice,
      prices: series.prices,
      actual: series.actual,
    } : undefined,
    // Trading balances
    playerBalance: Math.round((startMe + mePnl) * 100) / 100,
    rivalBalance: Math.round((startThem + themPnl) * 100) / 100,
    playerStartBalance: startMe,
    rivalStartBalance: startThem,
    lastRound,
  };
}
