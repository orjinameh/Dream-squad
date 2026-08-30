import { connectToDatabase } from "@/db/connect";
import { Match, ROUND_TIMINGS, type RoundPhase, type RoundRecord, type StatsProcessedStatus } from "@/db/models/Match";
import { PlayerStats } from "@/db/models/PlayerStats";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { executeGameRound, type RoundExecutionResult } from "@/lib/operator";
import { getPvpWinPoints } from "@/lib/rank";
import { z } from "zod";
import { isAddress } from "viem";
import { fetchLivePriceUsd } from "@/lib/prices-api";

const PAYOUT_MULTIPLIER = 1.8;

// Live one-tick resolution keeps the market noisy even when the live feed only
// moves a few bps, so round outcomes aren't trivially predictable. Anything
// within this band is judged FLAT.
const LIVE_RESOLUTION_FLAT_BAND_PCT = 0.0005;

const MAX_HP = 100;
const BASE_DAMAGE = 15;
const STREAK_BONUS: Record<number, number> = { 0: 0, 1: 0, 2: 3, 3: 10 };

const predictSchema = z.object({
  matchId: z.string().min(1),
  playerAddress: z.string().refine((v) => isAddress(v), "invalid address"),
  prediction: z.enum(["UP", "DOWN"]).optional(),
});

function calcDamage(streakCount: number): { damage: number; isCritical: boolean } {
  const bonus = STREAK_BONUS[Math.min(streakCount, 3)] ?? 0;
  const isCritical = streakCount >= 3;
  return { damage: BASE_DAMAGE + bonus, isCritical };
}

function computeLongestStreak(rounds: Array<{ playerCorrect: boolean }>): number {
  let max = 0;
  let current = 0;
  for (const r of rounds) {
    if (r.playerCorrect) { current++; if (current > max) max = current; }
    else { current = 0; }
  }
  return max;
}

/**
 * AUTHORITATIVE ROUND RESOLUTION
 * Single entry point for all round outcomes. Server calculates:
 * - market outcome (via DreamDEX execution)
 * - round winner
 * - scores
 * - streaks
 * - damage
 * - HP
 * - KO
 * - match completion
 *
 * Returns the full authoritative round result.
 */
async function resolveRound(match: any, now: Date): Promise<{
  roundRecord: RoundRecord;
  newPlayerScore: number;
  newRivalScore: number;
  newPlayerHP: number;
  newRivalHP: number;
  newPlayerStreak: number;
  newRivalStreak: number;
  matchDecided: boolean;
  winner: "player" | "rival" | "draw";
  playerBalance: number;
  rivalBalance: number;
}> {
  const marketSymbol = match.executionConfig?.marketSymbol ?? "SOMI:USDso";
  const roundNumber = match.currentRound;
  const matchId = match._id;

  const isPvP = match.opponentType === "player";
  const isBot = match.opponentType === "bot";
  const playerPred = match.playerPrediction as "UP" | "DOWN" | null;

  // Bot prediction: generate based on difficulty BEFORE execution
  let rivalPred: "UP" | "DOWN" | null = match.rivalPrediction as "UP" | "DOWN" | null;
  if (isBot && !rivalPred) {
    const difficulty = match.botDifficulty ?? "normal";
    const accuracy = difficulty === "easy" ? 0.30 : difficulty === "hard" ? 0.70 : 0.50;
    // Bot uses a simple bias: slightly favor UP (market uptrend) unless difficulty randomizes
    const randomFactor = Math.random();
    rivalPred = randomFactor < accuracy
      ? (playerPred ?? "UP")  // Match player's likely correct prediction
      : (playerPred === "UP" ? "DOWN" : "UP");  // Opposite of player
    // Ensure bot always has a prediction
    if (!rivalPred) rivalPred = Math.random() > 0.5 ? "UP" : "DOWN";
  }

  let playerResult: RoundExecutionResult | null = null;
  let rivalResult: RoundExecutionResult | null = null;

  // Per-player independent stakes. Each player trades their OWN amount; it
  // drives their on-chain order size and their P&L only, independent of the
  // opponent's stake.
  const playerBet = match.playerAmountPerRound ?? match.executionConfig?.amountPerRound ?? 1;
  const rivalBet = match.rivalAmountPerRound ?? match.executionConfig?.amountPerRound ?? 1;

  // Execute player's DreamDEX order (always for the human player)
  if (playerPred) {
    playerResult = await executeGameRound(marketSymbol, match.playerAddress, playerPred, roundNumber, matchId, playerBet);
  }

  // Bot matches: bot's DreamDEX order is NOT executed on-chain (no real funds)
  // Bot just predicts and outcome is derived from player's execution

  if (isPvP && rivalPred && match.player2Address) {
    rivalResult = await executeGameRound(marketSymbol, match.player2Address, rivalPred, roundNumber, matchId, rivalBet);
  }

  // REAL PRICE RESOLUTION — the DreamDEX oracle is the only source. The round's
  // open is anchored to the match entry price (round 1) or the previous round's
  // real close; the close is the live oracle spot fetched at resolution. No
  // synthetic path exists: if the real price can't be read, resolution throws
  // and the outer handler records an honest no-op draw (never a fake UP/DOWN).
  const entryPrice = match.priceModel?.entryPrice ?? 0;
  const resolvedRounds = match.rounds ?? [];
  const prevRound = resolvedRounds.length > 0 ? resolvedRounds[resolvedRounds.length - 1] : undefined;
  const anchorOpen = roundNumber === 1 ? entryPrice : (prevRound?.endPrice ?? entryPrice);
  const asset = match.priceModel?.asset ?? match.predictionAsset ?? "BTC";

  const liveClose = await fetchLivePriceUsd(marketSymbol);
  if (liveClose == null || !(anchorOpen > 0)) {
    throw new Error(`real price unavailable for ${marketSymbol} (open=${anchorOpen} close=${liveClose})`);
  }

  const band = anchorOpen * LIVE_RESOLUTION_FLAT_BAND_PCT;
  const diff = liveClose - anchorOpen;
  const actual: "UP" | "DOWN" | "FLAT" = diff > band ? "UP" : diff < -band ? "DOWN" : "FLAT";
  const startPrice = anchorOpen;
  const endPrice = liveClose;
  const volume = [startPrice, endPrice];

  const isFlat = actual === "FLAT";

  // FLAT = no directional winner. No score, no damage, no P&L change.
  const playerCorrect = !isFlat && playerPred === actual;
  const rivalCorrect = !isFlat && rivalPred === actual;
  const isDraw = isFlat || playerCorrect === rivalCorrect;
  const roundWinner = isDraw ? "draw" : playerCorrect ? "player" : "rival";

  // Trading P&L (non-zero-sum). Each player trades their OWN stake:
  // Correct = +bet*(multiplier-1), wrong = -bet. Independent per player.
  // In a FLAT round neither side is penalized (the trade is void).
  const playerPnL = !isFlat && playerPred
    ? (playerCorrect ? playerBet * (PAYOUT_MULTIPLIER - 1) : -playerBet)
    : 0;
  const rivalPnL = !isFlat && rivalPred
    ? (rivalCorrect ? rivalBet * (PAYOUT_MULTIPLIER - 1) : -rivalBet)
    : 0;

  // Running balance = start balance + cumulative P&L including this round.
  const playerStartBalance = match.playerStartBalance ?? 100;
  const rivalStartBalance = match.rivalStartBalance ?? 100;
  const playerBalance = roundPnl(playerStartBalance + cumulativePnL(match.rounds, "player") + playerPnL);
  const rivalBalance = roundPnl(rivalStartBalance + cumulativePnL(match.rounds, "rival") + rivalPnL);

  // Server-authoritative combat calculation
  let playerDamage = 0;
  let rivalDamage = 0;
  let isCritical = false;
  if (!isDraw) {
    if (playerCorrect) {
      const d = calcDamage(match.playerStreak);
      rivalDamage = d.damage;
      isCritical = d.isCritical;
    } else {
      const d = calcDamage(match.rivalStreak);
      playerDamage = d.damage;
      isCritical = d.isCritical;
    }
  }

  const newPlayerHP = Math.max(0, match.playerHP - playerDamage);
  const newRivalHP = Math.max(0, match.rivalHP - rivalDamage);
  const knockout = newPlayerHP <= 0 || newRivalHP <= 0;

  const newPlayerStreak = playerCorrect ? match.playerStreak + 1 : 0;
  const newRivalStreak = rivalCorrect ? match.rivalStreak + 1 : 0;

  const newPlayerScore = match.playerScore + (playerCorrect ? 1 : 0);
  const newRivalScore = match.rivalScore + (rivalCorrect ? 1 : 0);

  const roundRecord: RoundRecord = {
    roundNum: roundNumber,
    playerPrediction: playerPred,
    rivalPrediction: rivalPred,
    actual,
    playerCorrect,
    rivalCorrect,
    roundWinner,
    damage: Math.max(playerDamage, rivalDamage),
    playerDamage,
    rivalDamage,
    isCritical,
    knockout,
    // Coherent market series this round's outcome derives from
    startPrice,
    endPrice,
    prices: volume,
    asset,
    // Trading P&L
    playerPnL,
    rivalPnL,
    playerExecution: playerResult ? {
      status: playerResult.success ? "EXECUTED" : "FAILED",
      txHash: playerResult.txHash ?? undefined,
      blockNumber: playerResult.blockNumber ? Number(playerResult.blockNumber) : undefined,
      blockHash: playerResult.blockHash ?? undefined,
      gasUsed: playerResult.gasUsed ? Number(playerResult.gasUsed) : undefined,
      direction: playerResult.direction,
      amount: playerResult.amount,
      error: playerResult.error,
    } : undefined,
    rivalExecution: rivalResult ? {
      status: rivalResult.success ? "EXECUTED" : "FAILED",
      txHash: rivalResult.txHash ?? undefined,
      blockNumber: rivalResult.blockNumber ? Number(rivalResult.blockNumber) : undefined,
      blockHash: rivalResult.blockHash ?? undefined,
      gasUsed: rivalResult.gasUsed ? Number(rivalResult.gasUsed) : undefined,
      direction: rivalResult.direction,
      amount: rivalResult.amount,
      error: rivalResult.error,
    } : undefined,
    resolvedAt: now,
    playerBalance,
    rivalBalance,
  };

  // Determine if match is decided
  const remainingRounds = match.totalRounds - roundNumber;
  const playerMaxPossible = newPlayerScore + remainingRounds;
  const rivalMaxPossible = newRivalScore + remainingRounds;
  const matchDecided = knockout || roundNumber >= match.totalRounds ||
    newPlayerScore > rivalMaxPossible || newRivalScore > playerMaxPossible;

  const winner = newPlayerScore > newRivalScore ? "player"
    : newRivalScore > newPlayerScore ? "rival" : "draw";

  return {
    roundRecord, newPlayerScore, newRivalScore, newPlayerHP, newRivalHP,
    newPlayerStreak, newRivalStreak, matchDecided, winner,
    playerBalance, rivalBalance,
  };
}

/** Sum this player's P&L across already-resolved rounds. */
function cumulativePnL(rounds: any[], side: "player" | "rival"): number {
  const key = side === "player" ? "playerPnL" : "rivalPnL";
  return (rounds as any[]).reduce((sum, r) => sum + (r[key] ?? 0), 0);
}

function roundPnl(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * IDEMPOTENT PLAYER STATS UPDATE
 * Uses atomic filter to prevent double-processing.
 */
async function updatePlayerStatsAtomic(match: any, allRounds: any[], winner: string, now: Date) {
  const matchId = match._id;
  const P1_BET = match.playerAmountPerRound ?? match.executionConfig?.amountPerRound ?? 1;
  const P2_BET = match.rivalAmountPerRound ?? match.executionConfig?.amountPerRound ?? 1;

  // Player 1 stats — atomic: only process if not already processed
  const p1CorrectCount = allRounds.filter((r: any) => r.playerCorrect).length;
  const p1WrongCount = allRounds.filter((r: any) => !r.playerCorrect && r.playerPrediction).length;
  const p1TotalPreds = allRounds.length;
  const p1LongestStreak = computeLongestStreak(allRounds);
  const p1Win = winner === "player";
  const p1Draw = winner === "draw";
  const p1RankDelta = getPvpWinPoints(p1Win, p1Draw);
  const hasKO = allRounds.some((r: any) => r.knockout);

  // P&L: correct prediction = +bet*(multiplier-1), wrong = -bet (own stake)
  const p1PnL = (p1CorrectCount * P1_BET * (PAYOUT_MULTIPLIER - 1)) - (p1WrongCount * P1_BET);

  await PlayerStats.findOneAndUpdate(
    { _id: normalizeAddress(match.playerAddress), processedMatches: { $ne: matchId } },
    {
      $setOnInsert: { address: normalizeAddress(match.playerAddress) },
      $inc: {
        totalWins: p1Win ? 1 : 0,
        totalLosses: !p1Win && !p1Draw ? 1 : 0,
        totalDraws: p1Draw ? 1 : 0,
        totalMatches: 1,
        totalRounds: allRounds.length,
        correctPredictions: p1CorrectCount,
        totalPredictions: p1TotalPreds,
        ...(match.opponentType === "player" ? {
          pvpWins: p1Win ? 1 : 0,
          pvpLosses: !p1Win && !p1Draw ? 1 : 0,
          pvpDraws: p1Draw ? 1 : 0,
          pvpMatches: 1,
          pvpRounds: allRounds.length,
          pvpCorrectPredictions: p1CorrectCount,
        } : {
          botWins: p1Win ? 1 : 0,
          botLosses: !p1Win && !p1Draw ? 1 : 0,
          botDraws: p1Draw ? 1 : 0,
          botMatches: 1,
          botRounds: allRounds.length,
          botCorrectPredictions: p1CorrectCount,
        }),
        knockouts: hasKO && p1Win ? 1 : 0,
        timesKnockedOut: hasKO && !p1Win ? 1 : 0,
        rankPoints: p1RankDelta,
        balance: p1PnL,
        totalPnL: p1PnL,
      },
      $max: { longestStreak: p1LongestStreak },
      $addToSet: { processedMatches: matchId },
      $set: { lastPlayedAt: now, favoriteChar: match.playerChar },
    },
    { upsert: true },
  );

  // Player 2 stats (PvP only) — same atomic pattern
  if (match.opponentType === "player" && match.player2Address) {
    const p2CorrectCount = allRounds.filter((r: any) => r.rivalCorrect).length;
    const p2WrongCount = allRounds.filter((r: any) => !r.rivalCorrect && r.rivalPrediction).length;
    const p2Rounds = allRounds.map((r: any) => ({ playerCorrect: r.rivalCorrect }));
    const p2LongestStreak = computeLongestStreak(p2Rounds);
    const p2Win = winner === "rival";
    const p2Draw = winner === "draw";
    const p2RankDelta = getPvpWinPoints(p2Win, p2Draw);
    const p2Addr = normalizeAddress(match.player2Address);
    const p2PnL = (p2CorrectCount * P2_BET * (PAYOUT_MULTIPLIER - 1)) - (p2WrongCount * P2_BET);

    await PlayerStats.findOneAndUpdate(
      { _id: p2Addr, processedMatches: { $ne: matchId } },
      {
        $setOnInsert: { address: p2Addr },
        $inc: {
          totalWins: p2Win ? 1 : 0,
          totalLosses: !p2Win && !p2Draw ? 1 : 0,
          totalDraws: p2Draw ? 1 : 0,
          totalMatches: 1,
          totalRounds: allRounds.length,
          correctPredictions: p2CorrectCount,
          totalPredictions: allRounds.length,
          pvpWins: p2Win ? 1 : 0,
          pvpLosses: !p2Win && !p2Draw ? 1 : 0,
          pvpDraws: p2Draw ? 1 : 0,
          pvpMatches: 1,
          pvpRounds: allRounds.length,
          pvpCorrectPredictions: p2CorrectCount,
          knockouts: hasKO && p2Win ? 1 : 0,
          timesKnockedOut: hasKO && !p2Win ? 1 : 0,
          rankPoints: p2RankDelta,
          balance: p2PnL,
          totalPnL: p2PnL,
        },
        $max: { longestStreak: p2LongestStreak },
        $addToSet: { processedMatches: matchId },
        $set: { lastPlayedAt: now, favoriteChar: match.player2Char || "dreamer" },
      },
      { upsert: true },
    );
  }
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
    if (match.status !== "ACTIVE") {
      return Response.json(buildState(match, now));
    }

    const isPvP = match.opponentType === "player";
    const isPlayer1 = normalizeAddress(match.playerAddress) === address;
    const isPlayer2 = isPvP && match.player2Address && normalizeAddress(match.player2Address) === address;
    if (!isPlayer1 && !isPlayer2) return jsonError(403, "not a player in this match");

    const isBot = match.opponentType === "bot";
    const deadlinePassed = now.getTime() > match.roundDeadline.getTime();
    const isExpired = deadlinePassed && match.roundPhase === "ACTIVE";

    // Store prediction if provided and round is ACTIVE
    if (input.prediction && match.roundPhase === "ACTIVE" && !deadlinePassed) {
      const predField = isPlayer1 ? "playerPrediction" : "rivalPrediction";
      const existingPred = isPlayer1 ? match.playerPrediction : match.rivalPrediction;

      if (!existingPred) {
        const updateField: Record<string, "UP" | "DOWN"> = {};
        updateField[predField] = input.prediction;
        const atomicUpdate = await Match.findOneAndUpdate(
          { _id: match._id, [predField]: null, roundPhase: "ACTIVE" },
          { $set: updateField },
          { new: true },
        );
        if (atomicUpdate) {
          match.playerPrediction = atomicUpdate.playerPrediction;
          match.rivalPrediction = atomicUpdate.rivalPrediction;
        }
      }
    }

    // ATOMIC ROUND EXECUTION CLAIM
    // Only the first request to hit this wins the ACTIVE → EXECUTING transition
    if (match.roundPhase === "ACTIVE") {
      const claim = await Match.findOneAndUpdate(
        { _id: match._id, roundPhase: "ACTIVE", currentRound: match.currentRound, status: "ACTIVE" },
        { $set: { roundPhase: "EXECUTING" } },
        { new: true },
      );

      if (!claim) {
        // Another request already claimed EXECUTING — return current state
        const fresh = await Match.findById(match._id);
        return Response.json(buildState(fresh!, now));
      }

      // We won the claim. Now resolve.
      // For PvP: check if both have predicted. If not, wait.
      if (isPvP) {
        const bothPredicted = claim.playerPrediction && claim.rivalPrediction;
        if (!bothPredicted && !isExpired) {
          // Still waiting — revert to ACTIVE so the other player can predict
          await Match.findOneAndUpdate(
            { _id: match._id, roundPhase: "EXECUTING" },
            { $set: { roundPhase: "ACTIVE" } },
          );
          return Response.json({
            ...buildState(claim, now),
            waitingForOpponent: true,
          });
        }
        // PvP expired with no predictions: no-op round (draw, 0 damage)
        if (!claim.playerPrediction && !claim.rivalPrediction) {
          const cp = claim.priceModel?.checkpoints?.[claim.currentRound - 1];
          const roundRecord: RoundRecord = {
            roundNum: claim.currentRound,
            playerPrediction: null,
            rivalPrediction: null,
            actual: cp?.actual ?? "FLAT",
            playerCorrect: false,
            rivalCorrect: false,
            roundWinner: "draw",
            damage: 0,
            playerDamage: 0,
            rivalDamage: 0,
            isCritical: false,
            knockout: false,
            startPrice: cp?.startPrice,
            endPrice: cp?.endPrice,
            prices: cp?.prices ?? [],
            asset: claim.priceModel?.asset ?? claim.predictionAsset ?? "BTC",
            playerPnL: 0,
            rivalPnL: 0,
            resolvedAt: now,
          };
          const nextDeadline = new Date(now.getTime() + ROUND_TIMINGS.ROUND_DURATION_MS + ROUND_TIMINGS.LOCK_MS);
          const nextStatus = claim.currentRound >= claim.totalRounds ? "COMPLETED" : "ACTIVE";
          const nextRoundPhase: RoundPhase = claim.currentRound >= claim.totalRounds ? "REVEALED" : "ACTIVE";

          await Match.findByIdAndUpdate(match._id, {
            $push: { rounds: roundRecord },
            $set: {
              roundPhase: nextRoundPhase,
              status: nextStatus,
              ...(nextStatus === "COMPLETED" ? { completedAt: now, winner: "draw", statsProcessed: "PENDING" as StatsProcessedStatus } : {
                currentRound: claim.currentRound + 1,
                playerPrediction: null,
                rivalPrediction: null,
                roundStartTime: now,
                roundDeadline: nextDeadline,
              }),
            },
          });

          const updated = await Match.findById(match._id);
          if (updated && nextStatus === "COMPLETED") {
            await updatePlayerStatsAtomic(updated, updated.rounds, "draw", now);
          }
          return Response.json(buildState(updated!, now));
        }
      }

      // Execute and resolve
      try {
        const result = await resolveRound(claim, now);
        const { roundRecord, newPlayerScore, newRivalScore, newPlayerHP, newRivalHP, newPlayerStreak, newRivalStreak, matchDecided, winner, playerBalance, rivalBalance } = result;

        const nextDeadline = new Date(now.getTime() + ROUND_TIMINGS.ROUND_DURATION_MS + ROUND_TIMINGS.LOCK_MS);
        const nextStatus = matchDecided ? "COMPLETED" : "ACTIVE";
        const nextRoundPhase: RoundPhase = matchDecided ? "REVEALED" : "ACTIVE";

        const allRounds = [...(claim.rounds as any[]), roundRecord];

        await Match.findByIdAndUpdate(match._id, {
          $push: { rounds: roundRecord },
          $set: {
            playerPrediction: roundRecord.playerPrediction,
            rivalPrediction: roundRecord.rivalPrediction,
            playerScore: newPlayerScore,
            rivalScore: newRivalScore,
            playerHP: newPlayerHP,
            rivalHP: newRivalHP,
            playerStreak: newPlayerStreak,
            rivalStreak: newRivalStreak,
            roundPhase: nextRoundPhase,
            status: nextStatus,
            priceModel: {
              asset: roundRecord.asset ?? claim.priceModel?.asset ?? "BTC",
              entryPrice: claim.priceModel?.entryPrice ?? roundRecord.startPrice ?? 0,
              checkpoints: [...(claim.priceModel?.checkpoints ?? []), {
                roundNum: roundRecord.roundNum,
                startPrice: roundRecord.startPrice ?? 0,
                endPrice: roundRecord.endPrice ?? 0,
                prices: roundRecord.prices ?? [roundRecord.startPrice ?? 0, roundRecord.endPrice ?? 0],
                actual: roundRecord.actual,
              }],
            },
            ...(matchDecided ? {
              playerStartBalance: claim.playerStartBalance ?? 100,
              rivalStartBalance: claim.rivalStartBalance ?? 100,
              playerFinalBalance: playerBalance,
              rivalFinalBalance: rivalBalance,
              completedAt: now,
              winner,
              statsProcessed: "PENDING" as StatsProcessedStatus,
            } : {
              currentRound: claim.currentRound + 1,
              roundStartTime: now,
              roundDeadline: nextDeadline,
            }),
          },
        });

        // Idempotent stats update for completed matches
        if (matchDecided) {
          const matchForStats = { ...(typeof claim.toObject === "function" ? claim.toObject() : claim), rounds: allRounds };
          await updatePlayerStatsAtomic(matchForStats, allRounds, winner, now);
          await Match.findByIdAndUpdate(match._id, { $set: { statsProcessed: "COMPLETE" as StatsProcessedStatus } });
        }

        const updated = await Match.findById(match._id);
        return Response.json(buildState(updated!, now));
      } catch (err) {
        // DreamDEX execution failed — record a no-op draw round and ADVANCE,
        // so a testnet execution failure never hard-freezes the match.
        console.error("[predict] round resolution failed", err);
        const failRound: RoundRecord = {
          roundNum: match.currentRound,
          playerPrediction: claim.playerPrediction,
          rivalPrediction: claim.rivalPrediction,
          actual: "FLAT",
          playerCorrect: false,
          rivalCorrect: false,
          roundWinner: "draw",
          damage: 0,
          playerDamage: 0,
          rivalDamage: 0,
          isCritical: false,
          knockout: false,
          playerPnL: 0,
          rivalPnL: 0,
          resolvedAt: now,
        };

        const lastRoundNum = match.currentRound;
        const decided = lastRoundNum >= match.totalRounds || (claim.playerHP === 0 && claim.rivalHP === 0);
        const nextDeadline = new Date(now.getTime() + ROUND_TIMINGS.ROUND_DURATION_MS + ROUND_TIMINGS.LOCK_MS);
        const nextRoundPhase: RoundPhase = decided ? "REVEALED" : "ACTIVE";
        const nextStatus = decided ? "COMPLETED" : "ACTIVE";

        await Match.findByIdAndUpdate(match._id, {
          $push: { rounds: failRound },
          $set: {
            roundPhase: nextRoundPhase,
            status: nextStatus,
            playerPrediction: claim.playerPrediction,
            rivalPrediction: claim.rivalPrediction,
            ...(decided ? {
              playerFinalBalance: match.playerStartBalance ?? 100,
              rivalFinalBalance: match.rivalStartBalance ?? 100,
              completedAt: now,
              winner: "draw",
              statsProcessed: "PENDING" as StatsProcessedStatus,
            } : {
              currentRound: lastRoundNum + 1,
              roundStartTime: now,
              roundDeadline: nextDeadline,
            }),
          },
        });
        const updated = await Match.findById(match._id);
        if (decided && updated) {
          await updatePlayerStatsAtomic(updated, updated.rounds ?? [], "draw", now);
          await Match.findByIdAndUpdate(match._id, { $set: { statsProcessed: "COMPLETE" as StatsProcessedStatus } });
          const finalized = await Match.findById(match._id);
          return Response.json({ ...buildState(finalized!, now), executionFailed: true, error: "DreamDEX execution failed, round recorded as no-op" });
        }
        return Response.json({ ...buildState(updated!, now), executionFailed: true, error: "DreamDEX execution failed, round recorded as no-op" });
      }
    }

    // If round is EXECUTING or REVEALED, just return current state
    const fresh = await Match.findById(match._id);
    return Response.json(buildState(fresh!, now));
  } catch (err) {
    console.error("predict failed", err);
    return jsonError(500, "failed to submit prediction");
  }
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
  rounds: RoundRecord[];
  winner: string;
  opponentType?: string;
  player2Char?: string;
  player1Ready?: boolean;
  player2Ready?: boolean;
  predictionAsset?: string;
  predictionQuestion?: string;
  botDifficulty?: string;
  marketId?: string;
  // Server-authoritative combat
  playerHP: number;
  rivalHP: number;
  playerStreak: number;
  rivalStreak: number;
  lastRound?: RoundRecord;
  // Coherent market series the current round's outcome will derive from
  market?: {
    asset: string;
    startPrice: number;
    endPrice: number;
    prices: number[];
    actual: "UP" | "DOWN" | "FLAT";
  };
  // Trading balance (STT)
  playerBalance: number;
  rivalBalance: number;
  playerStartBalance: number;
  rivalStartBalance: number;
}

function buildState(match: any, serverTime: Date): MatchStateResponse {
  const rounds = match.rounds ?? [];
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : undefined;

  // For an unresolved ACTIVE round, expose the REAL anchor for this round: the
  // entry price (round 1) or the previous round's real close. The live close is
  // read by the on-chain chart; nothing here is synthesized.
  const asset = match.priceModel?.asset ?? match.predictionAsset ?? "BTC";
  const entryPrice = match.priceModel?.entryPrice ?? 0;
  const prevRound = rounds.length > 0 ? rounds[rounds.length - 1] : undefined;
  const currentOpen = match.currentRound === 1 ? entryPrice : (prevRound?.endPrice ?? entryPrice);
  const currentCheckpoint = match.roundPhase === "ACTIVE" && match.status === "ACTIVE"
    ? {
        startPrice: currentOpen,
        endPrice: currentOpen,
        prices: currentOpen > 0 ? [currentOpen] : [],
        actual: "FLAT" as const,
      }
    : undefined;

  // Running balance on the latest resolved round (or start balance).
  const lastPlayerPnl = rounds.reduce((s: number, r: any) => s + (r.playerPnL ?? 0), 0);
  const lastRivalPnl = rounds.reduce((s: number, r: any) => s + (r.rivalPnL ?? 0), 0);
  const playerStartBalance = match.playerStartBalance ?? 100;
  const rivalStartBalance = match.rivalStartBalance ?? 100;

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
    rounds,
    winner: match.winner ?? "player",
    opponentType: match.opponentType,
    player2Char: match.player2Char,
    player1Ready: match.player1Ready,
    player2Ready: match.player2Ready,
    predictionAsset: match.predictionAsset,
    predictionQuestion: match.predictionQuestion,
    botDifficulty: match.botDifficulty,
    marketId: match.marketId,
    playerHP: match.playerHP ?? MAX_HP,
    rivalHP: match.rivalHP ?? MAX_HP,
    playerStreak: match.playerStreak ?? 0,
    rivalStreak: match.rivalStreak ?? 0,
    market: currentCheckpoint ? {
      asset,
      startPrice: currentCheckpoint.startPrice,
      endPrice: currentCheckpoint.endPrice,
      prices: currentCheckpoint.prices,
      actual: currentCheckpoint.actual,
    } : undefined,
    playerBalance: round2(playerStartBalance + lastPlayerPnl),
    rivalBalance: round2(rivalStartBalance + lastRivalPnl),
    playerStartBalance,
    rivalStartBalance,
    lastRound,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
