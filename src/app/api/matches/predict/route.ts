import { connectToDatabase } from "@/db/connect";
import { Match, ROUND_TIMINGS } from "@/db/models/Match";
import { PlayerStats } from "@/db/models/PlayerStats";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";
import { executeGameRound, deriveRoundOutcome, type RoundExecutionResult } from "@/lib/operator";
import { MARKETS } from "@/lib/markets";
import { getPvpWinPoints } from "@/lib/rank";
import { z } from "zod";
import { isAddress } from "viem";

const predictSchema = z.object({
  matchId: z.string().min(1),
  playerAddress: z.string().refine((v) => isAddress(v), "invalid address"),
  prediction: z.enum(["UP", "DOWN"]),
  clientTimestamp: z.string().optional(),
});

function computeLongestStreak(rounds: Array<{ playerCorrect: boolean }>): number {
  let max = 0;
  let current = 0;
  for (const r of rounds) {
    if (r.playerCorrect) {
      current++;
      if (current > max) max = current;
    } else {
      current = 0;
    }
  }
  return max;
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError(400, "body must be JSON"); }

  const parsed = predictSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, `validation failed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const input = parsed.data;
  const now = new Date();

  try {
    await connectToDatabase();
    const address = normalizeAddress(input.playerAddress);

    const match = await Match.findById(input.matchId);
    if (!match) return jsonError(404, "match not found");
    if (match.status !== "ACTIVE") return jsonError(409, "match not active");

    const isPvP = match.opponentType === "player";

    // Validate player identity
    const isPlayer1 = normalizeAddress(match.playerAddress) === address;
    const isPlayer2 = isPvP && match.player2Address && normalizeAddress(match.player2Address) === address;

    if (!isPlayer1 && !isPlayer2) return jsonError(403, "not a player in this match");

    // DEADLINE VALIDATION: server clock is authoritative
    if (now.getTime() > match.roundDeadline.getTime() + 500) {
      return jsonError(409, "round deadline passed");
    }

    // Store prediction based on which player submitted
    const predField = isPlayer1 ? "playerPrediction" : "rivalPrediction";
    const existingPred = isPlayer1 ? match.playerPrediction : match.rivalPrediction;

    // Idempotency: if already predicted this round, return current state
    if (existingPred) {
      return Response.json(buildState(match, now));
    }

    // Set this player's prediction
    const updateField: Record<string, "UP" | "DOWN"> = {};
    updateField[predField] = input.prediction;
    await Match.findByIdAndUpdate(match._id, { $set: updateField });

    // Re-read to get both predictions
    const updated = await Match.findById(match._id);
    if (!updated) return jsonError(500, "match disappeared");

    // PvP: wait for both players to submit before resolving
    if (isPvP) {
      const bothPredicted = updated.playerPrediction && updated.rivalPrediction;

      if (!bothPredicted) {
        // Still waiting for opponent — return partial state
        return Response.json({
          ...buildState(updated, now),
          waitingForOpponent: true,
        });
      }

      // Both predicted — resolve the round with real DreamDEX execution
      return await resolvePvPRound(updated, now);
    }

    // Bot match: execute player's order on DreamDEX, generate bot prediction
    return await resolveBotRound(updated, input.prediction, now);
  } catch (err) {
    console.error("predict failed", err);
    return jsonError(500, "failed to submit prediction");
  }
}

/**
 * Resolve a PvP round: execute both players' IOC orders on DreamDEX.
 */
async function resolvePvPRound(match: any, now: Date): Promise<Response> {
  const marketSymbol = match.executionConfig?.marketSymbol ?? "SOMI:USDso";
  const roundNumber = match.currentRound;
  const matchId = match._id;
  const amount = match.executionConfig?.amountPerRound ?? 1;

  // Execute Player 1's order
  const player1Result = await executeGameRound(
    marketSymbol,
    match.playerAddress,
    match.playerPrediction,
    roundNumber,
    matchId,
  );

  // Execute Player 2's order
  const player2Result = await executeGameRound(
    marketSymbol,
    match.player2Address,
    match.rivalPrediction,
    roundNumber,
    matchId,
  );

  // Determine round outcome from on-chain execution
  const actual = determineOutcome(player1Result, player2Result, roundNumber);
  const playerCorrect = match.playerPrediction === actual;
  const rivalCorrect = match.rivalPrediction === actual;

  return await finalizeRound(match, match.playerPrediction, match.rivalPrediction, actual, playerCorrect, rivalCorrect, now, player1Result, player2Result);
}

/**
 * Resolve a bot round: execute player's order on DreamDEX, bot prediction is local.
 */
async function resolveBotRound(match: any, playerPrediction: "UP" | "DOWN", now: Date): Promise<Response> {
  const marketSymbol = match.executionConfig?.marketSymbol ?? "SOMI:USDso";
  const roundNumber = match.currentRound;
  const matchId = match._id;
  const amount = match.executionConfig?.amountPerRound ?? MARKETS[marketSymbol]?.minAmount ?? 1;

  // Execute player's IOC order on DreamDEX
  const playerResult = await executeGameRound(
    marketSymbol,
    match.playerAddress,
    playerPrediction,
    roundNumber,
    matchId,
  );

  // Bot prediction: based on difficulty bias, resolved locally
  const difficulty = match.botDifficulty || "normal";
  const botCorrectBias = difficulty === "easy" ? 0.35 : difficulty === "hard" ? 0.65 : 0.5;

  // Use the execution-derived outcome as the authoritative actual
  const actual = playerResult.roundOutcome;
  const botShouldBeCorrect = Math.random() < botCorrectBias;
  const rivalPred = botShouldBeCorrect ? actual : (actual === "UP" ? "DOWN" as const : "UP" as const);
  const playerCorrect = playerPrediction === actual;
  const rivalCorrect = rivalPred === actual;

  // Bot execution is simulated (no real on-chain tx)
  const botExecution: RoundExecutionResult = {
    success: true,
    txHash: null,
    blockNumber: null,
    blockHash: null,
    gasUsed: null,
    direction: rivalPred === "UP" ? "BUY" : "SELL",
    amount,
    marketSymbol,
    roundOutcome: actual,
  };

  return await finalizeRound(match, playerPrediction, rivalPred, actual, playerCorrect, rivalCorrect, now, playerResult, botExecution);
}

/**
 * Determine the authoritative round outcome from on-chain execution results.
 * Uses the player1 txHash as the source of truth for the round.
 * Both players see the same outcome.
 */
function determineOutcome(
  p1Result: RoundExecutionResult,
  p2Result: RoundExecutionResult,
  roundNumber: number,
): "UP" | "DOWN" {
  // If one execution succeeded and the other failed, the successful one determines the outcome
  if (p1Result.success && !p2Result.success) return p1Result.roundOutcome;
  if (!p1Result.success && p2Result.success) return p2Result.roundOutcome;

  // Both succeeded: use player1's txHash for deterministic outcome
  if (p1Result.success && p2Result.success && p1Result.txHash) {
    return deriveRoundOutcome(p1Result.txHash, roundNumber);
  }

  // Both failed: fallback to player1's prediction direction as the actual
  // (This is a degraded state — logged for diagnostics)
  console.error(`[predict] both executions failed for round ${roundNumber}`, {
    p1Error: p1Result.error,
    p2Error: p2Result.error,
  });
  return "UP"; // deterministic fallback
}

async function finalizeRound(
  match: any,
  playerPred: "UP" | "DOWN",
  rivalPred: "UP" | "DOWN",
  actual: "UP" | "DOWN",
  playerCorrect: boolean,
  rivalCorrect: boolean,
  now: Date,
  playerExec?: RoundExecutionResult,
  rivalExec?: RoundExecutionResult,
): Promise<Response> {
  const roundRecord: any = {
    roundNum: match.currentRound,
    playerPrediction: playerPred,
    rivalPrediction: rivalPred,
    actual,
    playerCorrect,
    rivalCorrect,
    resolvedAt: now,
  };

  // Attach execution details
  if (playerExec) {
    roundRecord.playerExecution = {
      status: playerExec.success ? "EXECUTED" : "FAILED",
      txHash: playerExec.txHash ?? undefined,
      blockNumber: playerExec.blockNumber ? Number(playerExec.blockNumber) : undefined,
      blockHash: playerExec.blockHash ?? undefined,
      gasUsed: playerExec.gasUsed ? Number(playerExec.gasUsed) : undefined,
      direction: playerExec.direction,
      amount: playerExec.amount,
      error: playerExec.error,
    };
  }
  if (rivalExec) {
    roundRecord.rivalExecution = {
      status: rivalExec.success ? "EXECUTED" : "FAILED",
      txHash: rivalExec.txHash ?? undefined,
      blockNumber: rivalExec.blockNumber ? Number(rivalExec.blockNumber) : undefined,
      blockHash: rivalExec.blockHash ?? undefined,
      gasUsed: rivalExec.gasUsed ? Number(rivalExec.gasUsed) : undefined,
      direction: rivalExec.direction,
      amount: rivalExec.amount,
      error: rivalExec.error,
    };
  }

  const newPlayerScore = match.playerScore + (playerCorrect ? 1 : 0);
  const newRivalScore = match.rivalScore + (rivalCorrect ? 1 : 0);
  const isLastRound = match.currentRound >= match.totalRounds;
  const nextDeadline = new Date(now.getTime() + ROUND_TIMINGS.LOCK_MS + ROUND_TIMINGS.REVEAL_MS + ROUND_TIMINGS.IMPACT_MS + 500);

  if (isLastRound) {
    const winner = newPlayerScore > newRivalScore ? "player" : newRivalScore > newPlayerScore ? "rival" : "draw";
    const allRounds = [...(match.rounds as any[]), roundRecord];

    await Match.findByIdAndUpdate(match._id, {
      $push: { rounds: roundRecord },
      $set: {
        playerPrediction: playerPred,
        rivalPrediction: rivalPred,
        playerScore: newPlayerScore,
        rivalScore: newRivalScore,
        winner,
        status: "COMPLETED",
        roundPhase: "REVEALED",
        completedAt: now,
      },
    });

    await updatePlayerStats(match, allRounds, winner, now);
  } else {
    // Check early victory: can the trailing player still catch up?
    const remainingRounds = match.totalRounds - match.currentRound;
    const playerMaxPossible = newPlayerScore + remainingRounds;
    const rivalMaxPossible = newRivalScore + remainingRounds;
    const matchDecided = newPlayerScore > rivalMaxPossible || newRivalScore > playerMaxPossible;

    if (matchDecided) {
      const winner = newPlayerScore > newRivalScore ? "player" : newRivalScore > newPlayerScore ? "rival" : "draw";
      const allRounds = [...(match.rounds as any[]), roundRecord];

      await Match.findByIdAndUpdate(match._id, {
        $push: { rounds: roundRecord },
        $set: {
          playerPrediction: playerPred,
          rivalPrediction: rivalPred,
          playerScore: newPlayerScore,
          rivalScore: newRivalScore,
          winner,
          status: "COMPLETED",
          completedAt: now,
        },
      });

      // Update both players' stats
      await updatePlayerStats(match, allRounds, winner, now);
    } else {
      await Match.findByIdAndUpdate(match._id, {
        $push: { rounds: roundRecord },
        $set: {
          playerPrediction: playerPred,
          rivalPrediction: rivalPred,
          playerScore: newPlayerScore,
          rivalScore: newRivalScore,
          currentRound: match.currentRound + 1,
          roundPhase: "LOCKED",
          roundStartTime: now,
          roundDeadline: nextDeadline,
        },
      });
    }
  }

  const updated = await Match.findById(match._id);
  return Response.json(buildState(updated!, now));
}

export interface MatchStateResponse {
  matchId: string;
  status: string;
  mode: string;
  totalRounds: number;
  currentRound: number;
  roundPhase: string;
  roundStartTime: string;
  roundDeadline: string;
  serverTime: string;
  playerScore: number;
  rivalScore: number;
  playerPrediction: "UP" | "DOWN" | null;
  rivalPrediction: "UP" | "DOWN" | null;
  rounds: Array<{
    roundNum: number;
    playerPrediction: "UP" | "DOWN" | null;
    rivalPrediction: "UP" | "DOWN" | null;
    actual: "UP" | "DOWN";
    playerCorrect: boolean;
    rivalCorrect: boolean;
    playerExecution?: {
      status: string;
      txHash?: string;
      direction?: string;
      error?: string;
    };
    rivalExecution?: {
      status: string;
      txHash?: string;
      direction?: string;
      error?: string;
    };
  }>;
  winner: string;
  opponentType?: string;
  player2Address?: string;
  player2Char?: string;
  player1Ready?: boolean;
  player2Ready?: boolean;
  predictionAsset?: string;
  predictionQuestion?: string;
  botDifficulty?: string;
  marketId?: string;
}

async function updatePlayerStats(match: any, allRounds: any[], winner: string, now: Date) {
  const matchId = match._id;

  // Player 1 stats
  const p1CorrectCount = allRounds.filter((r: any) => r.playerCorrect).length;
  const p1LongestStreak = computeLongestStreak(allRounds);
  const p1Win = winner === "player";
  const p1Draw = winner === "draw";
  const p1RankDelta = getPvpWinPoints(p1Win, p1Draw);
  const hasKO = allRounds.some((r: any) => r.ko);

  await PlayerStats.findOneAndUpdate(
    { _id: normalizeAddress(match.playerAddress) },
    {
      $setOnInsert: { address: normalizeAddress(match.playerAddress) },
      $inc: {
        totalWins: p1Win ? 1 : 0,
        totalLosses: !p1Win && !p1Draw ? 1 : 0,
        totalDraws: p1Draw ? 1 : 0,
        totalMatches: 1,
        totalRounds: allRounds.length,
        correctPredictions: p1CorrectCount,
        pvpWins: p1Win ? 1 : 0,
        pvpLosses: !p1Win && !p1Draw ? 1 : 0,
        pvpDraws: p1Draw ? 1 : 0,
        pvpMatches: 1,
        pvpRounds: allRounds.length,
        pvpCorrectPredictions: p1CorrectCount,
        knockouts: hasKO && p1Win ? 1 : 0,
        timesKnockedOut: hasKO && !p1Win ? 1 : 0,
        rankPoints: p1RankDelta,
      },
      $max: { longestStreak: p1LongestStreak },
      $addToSet: { processedMatches: matchId },
      $set: { lastPlayedAt: now, favoriteChar: match.playerChar },
    },
    { upsert: true },
  );

  // Player 2 stats (PvP only)
  if (match.opponentType === "player" && match.player2Address) {
    const p2CorrectCount = allRounds.filter((r: any) => r.rivalCorrect).length;
    const p2Rounds = allRounds.map((r: any) => ({ playerCorrect: r.rivalCorrect }));
    const p2LongestStreak = computeLongestStreak(p2Rounds);
    const p2Win = winner === "rival";
    const p2Draw = winner === "draw";
    const p2RankDelta = getPvpWinPoints(p2Win, p2Draw);

    await PlayerStats.findOneAndUpdate(
      { _id: normalizeAddress(match.player2Address) },
      {
        $setOnInsert: { address: normalizeAddress(match.player2Address) },
        $inc: {
          totalWins: p2Win ? 1 : 0,
          totalLosses: !p2Win && !p2Draw ? 1 : 0,
          totalDraws: p2Draw ? 1 : 0,
          totalMatches: 1,
          totalRounds: allRounds.length,
          correctPredictions: p2CorrectCount,
          pvpWins: p2Win ? 1 : 0,
          pvpLosses: !p2Win && !p2Draw ? 1 : 0,
          pvpDraws: p2Draw ? 1 : 0,
          pvpMatches: 1,
          pvpRounds: allRounds.length,
          pvpCorrectPredictions: p2CorrectCount,
          knockouts: hasKO && p2Win ? 1 : 0,
          timesKnockedOut: hasKO && !p2Win ? 1 : 0,
          rankPoints: p2RankDelta,
        },
        $max: { longestStreak: p2LongestStreak },
        $addToSet: { processedMatches: matchId },
        $set: { lastPlayedAt: now, favoriteChar: match.player2Char || "dreamer" },
      },
      { upsert: true },
    );
  }
}

function buildState(match: any, serverTime: Date): MatchStateResponse {
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
    playerScore: match.playerScore,
    rivalScore: match.rivalScore,
    playerPrediction: match.playerPrediction ?? null,
    rivalPrediction: match.rivalPrediction ?? null,
    rounds: match.rounds ?? [],
    winner: match.winner ?? "player",
    opponentType: match.opponentType,
    player2Address: match.player2Address,
    player2Char: match.player2Char,
    player1Ready: match.player1Ready,
    player2Ready: match.player2Ready,
    predictionAsset: match.predictionAsset,
    predictionQuestion: match.predictionQuestion,
    botDifficulty: match.botDifficulty,
    marketId: match.marketId,
  };
}
