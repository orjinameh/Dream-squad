import { connectToDatabase } from "@/db/connect";
import { Match, ROUND_TIMINGS, type RoundPhase, type RoundRecord, type StatsProcessedStatus } from "@/db/models/Match";
import { PlayerStats } from "@/db/models/PlayerStats";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { getPvpWinPoints } from "@/lib/rank";
import { readArenaPrice, resolveArenaOutcome, type ArenaRef } from "@/lib/ec/executor";
import { ecArenaForMatch, ecArenaForRound } from "@/lib/ec/arena";
import { stakePlayerRoundOnDreamDEX } from "@/lib/ec/staker";
import { EC_COLLATERAL_DECIMALS } from "@/lib/ec/config";
import { z } from "zod";
import { isAddress } from "viem";
import { randomBytes } from "node:crypto";

// CSPRNG float in [0, 1) — avoid Math.random() for anything influencing the
// bot's prediction decisions.
function randomDouble(): number {
  return randomBytes(6).readUIntLE(0, 6) / 0x1000000000000;
}

const MAX_HP = 100;
const BASE_DAMAGE = 15;
const STREAK_BONUS: Record<number, number> = { 0: 0, 1: 0, 2: 3, 3: 10 };

// Step 5 of the game flow: the tiny 10-second price fluctuation is multiplied
// into COMBAT DAMAGE. A round that moved decisively past the FLAT band lands a
// harder hit than a barely-directional round. `decisiveness` is the leveraged
// YES-mid delta minus the FLAT band (how far the move overshot "no movement").
// A move past ~MOVE_DAMAGE_REF yields the full bonus; marginal rounds stay close
// to BASE_DAMAGE. Streak bonuses still fold on top.
const MAX_MOVE_DAMAGE = 15;
const MOVE_DAMAGE_REF = 0.4;

const predictSchema = z.object({
  matchId: z.string().min(1),
  playerAddress: z.string().refine((v) => isAddress(v), "invalid address"),
  prediction: z.enum(["UP", "DOWN"]).optional(),
});

function calcDamage(streakCount: number, decisiveness: number): { damage: number; isCritical: boolean } {
  const streakBonus = STREAK_BONUS[Math.min(streakCount, 3)] ?? 0;
  const moveBonus = Math.min(MAX_MOVE_DAMAGE, Math.round(Math.max(0, decisiveness) * (MAX_MOVE_DAMAGE / MOVE_DAMAGE_REF)));
  const isCritical = streakCount >= 3;
  return { damage: BASE_DAMAGE + moveBonus + streakBonus, isCritical };
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

// Flat band for the EC YES-price oracle (probability scale 0..1). Any round
// whose YES mid moves by less than this is judged FLAT.
const EC_ORACLE_FLAT_BAND = 0.0008;
// A round must move past HALF the live bid-ask spread (in addition to the flat
// band) to count as UP/DOWN. The venue books are thin with ~2-3% spreads and the
// mid-of-book is stable within a 10s round, so a tiny absolute mid-delta is not a
// real directional signal — but a move that crosses/reshapes the spread is. This
// makes rounds resolve against genuine flow instead of a frozen mid. (A move
// wider than half the ask<=>bid spread is an unambiguous directional print.)
const EC_ORACLE_SPREAD_FACTOR = 0.5;

// LEVERAGE MULTIPLIER for round resolution. The EC YES mid is a binary probability
// (0..1) on a thin book, so it drifts only a few bp across a ~10s round while the
// underlying spot chart moves a lot. That tiny raw drift lands under the FLAT band
// and every round resolves as a 0-0 draw — "round is always flat even though the
// chart is moving". Amplifying the measured mid-delta by this factor turns real
// small directional flow into a decisive UP/DOWN while the honest band logic
// (flat/spread thresholds) still suppresses true no-movement rounds.
const EC_RESOLUTION_LEVERAGE = 100;

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
}> {
  const roundNumber = match.currentRound;

  const isPvP = match.opponentType === "player";
  const isBot = match.opponentType === "bot";
  const playerPred = match.playerPrediction as "UP" | "DOWN" | null;

  // Bot prediction: an INDEPENDENT, randomized move each round. It is NEVER
  // derived from the player's call — the bot does not see or copy the player.
  // Each round the bot commits a fair-coin UP/DOWN (its own input), and its
  // correctness against the real market decides whether it lands a hit. This is
  // the honest "bot input is randomized" combat model: the round's actual market
  // direction, not the player's move, is what the bot is compared against.
  let rivalPred: "UP" | "DOWN" | null = match.rivalPrediction as "UP" | "DOWN" | null;
  if (isBot && !rivalPred) {
    rivalPred = randomDouble() < 0.5 ? "UP" : "DOWN";
  }

  // REAL EC PROTOCOL RESOLUTION — the round's pinned arena window IS the judge.
  // The player's stake this round went INTO this market (a real BUY_YES/BUY_NO
  // placed on the round's window). When the window closes the protocol itself
  // resolves it to Up/Down (`winningOutcome`: 0=Up/YES, 1=Down/NO); that on-chain
  // result decides the round. If the oracle hasn't finalised yet (indexer/grace
  // lag), fall back to the honest commit-start → round-end price DIRECTION via
  // the real order-book mid — the move "commit end → round end" describes.
  const resolvedRounds = match.rounds ?? [];
  const prevRound = resolvedRounds.length > 0 ? resolvedRounds[resolvedRounds.length - 1] : undefined;
  const asset = (match.priceModel?.asset ?? match.predictionAsset ?? "BTC") as "BTC" | "ETH";

  const cp = match.priceModel?.checkpoints?.[roundNumber - 1];
  const arena = (cp?.arena?.marketId && cp.arena.marketId.length > 4)
    ? cp.arena
    : await ecArenaForRound(match, asset, roundNumber - 1, { preferBook: true });
  if (!arena) {
    throw new Error(`no live EC arena floor for ${asset} — arena is between windows`);
  }

  const outcome = await resolveArenaOutcome(arena, cp?.entryPrice ?? null);
  const actual: "UP" | "DOWN" | "FLAT" = outcome.actual;
  const resolutionSource = outcome.source;
  const startPrice = cp?.entryPrice ?? undefined;
  // Exit reference for display: the resolution winner (Up⇢1 / Down⇢0), else the
  // live exit mid observed for the direction fallback.
  let endPrice: number | undefined;
  if (outcome.source === "resolution") {
    endPrice = actual === "UP" ? 1 : 0;
  } else {
    const exitQuote = await readArenaPrice(arena).catch(() => null);
    endPrice = exitQuote?.yesPrice && exitQuote.yesPrice > 0 ? exitQuote.yesPrice : startPrice;
  }
  const volume: number[] = [startPrice ?? 0, endPrice ?? 0];

  const isFlat = actual === "FLAT";

  // The protocol's (or the honest direction's) winner decides the round. The
  // player's on-chain stake mirrors their call, so a correct call == a won stake.
  const playerCorrect = !isFlat && playerPred === actual;
  const rivalCorrect = !isFlat && rivalPred === actual;
  const isDraw = isFlat || playerCorrect === rivalCorrect;
  const roundWinner = isDraw ? "draw" : playerCorrect ? "player" : "rival";

  // Combat damage: real result decides the winner; no mid-delta amplitude bonus.
  let playerDamage = 0;
  let rivalDamage = 0;
  let isCritical = false;
  if (!isDraw) {
    if (playerCorrect) {
      const d = calcDamage(match.playerStreak, 0);
      rivalDamage = d.damage;
      isCritical = d.isCritical;
    } else {
      const d = calcDamage(match.rivalStreak, 0);
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
    resolutionSource,
    arena: arena
      ? { marketId: arena.marketId, poolAddress: arena.pool, symbol: arena.symbol, expiry: arena.expiry }
      : undefined,
    resolvedAt: now,
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
  };
}

/** Remove the per-round P&L helpers — matches are stats/rank only. */

/**
 * IDEMPOTENT PLAYER STATS UPDATE
 * Uses atomic filter to prevent double-processing.
 */
async function updatePlayerStatsAtomic(match: any, allRounds: any[], winner: string, now: Date) {
  const matchId = match._id;

  // Player 1 stats — atomic: only process if not already processed
  const p1CorrectCount = allRounds.filter((r: any) => r.playerCorrect).length;
  const p1TotalPreds = allRounds.length;
  const p1LongestStreak = computeLongestStreak(allRounds);
  const p1Win = winner === "player";
  const p1Draw = winner === "draw";
  // Rank points only move for REAL PvP matches — a bot win/loss must never
  // inflate or deflate a player's ranking (rank reflects PvP skill, not
  // bot grinding).
  const p1RankDelta = match.opponentType === "player" ? getPvpWinPoints(p1Win, p1Draw) : 0;
  const hasKO = allRounds.some((r: any) => r.knockout);

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
      },
      $max: { longestStreak: p1LongestStreak },
      $addToSet: { processedMatches: matchId },
      $set: { lastPlayedAt: now, favoriteChar: match.playerChar },
    },
    { upsert: true },
  );
  await capProcessedArrays(match.playerAddress);

  // Player 2 stats (PvP only) — same atomic pattern
  if (match.opponentType === "player" && match.player2Address) {
    const p2CorrectCount = allRounds.filter((r: any) => r.rivalCorrect).length;
    const p2Rounds = allRounds.map((r: any) => ({ playerCorrect: r.rivalCorrect }));
    const p2LongestStreak = computeLongestStreak(p2Rounds);
    const p2Win = winner === "rival";
    const p2Draw = winner === "draw";
    const p2RankDelta = getPvpWinPoints(p2Win, p2Draw);
    const p2Addr = normalizeAddress(match.player2Address);

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
        },
        $max: { longestStreak: p2LongestStreak },
        $addToSet: { processedMatches: matchId },
        $set: { lastPlayedAt: now, favoriteChar: match.player2Char || "dreamer" },
      },
      { upsert: true },
    );
    await capProcessedArrays(match.player2Address);
  }
}

// Cap the idempotency bookkeeping so a long-lived player's stats doc can't grow
// toward MongoDB's 16MB limit (schema comment claims 200 but $addToSet grows
// unboundedly). Keep only the most recent entries.
const MAX_PROCESSED_MATCHES = 200;
const MAX_PROCESSED_ROUNDS = 300;

async function capProcessedArrays(addr: string): Promise<void> {
  try {
    await PlayerStats.updateOne(
      { _id: normalizeAddress(addr) },
      {
        $push: {
          processedMatches: { $each: [], $slice: -MAX_PROCESSED_MATCHES },
          processedRounds: { $each: [], $slice: -MAX_PROCESSED_ROUNDS },
        },
      },
    );
  } catch (err) {
    console.error("[stats] failed to cap processed arrays", err);
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

    // ── GHOST FUNDING GATE (server-authoritative) ─────────────────────────
    // A bot match MUST have its one-time ghost deposit funded before any round
    // can resolve. The fight can never run nor advance unfunded. If the relay
    // hasn't landed yet, hold: return current state without recording the
    // prediction or advancing the round. The client shows a blocking FUND g
    // screen; once `/api/matches/ghost` sets `match.funded=true` this lets go.
    if (isBot && !match.funded) {
      return Response.json({ ...buildState(match, now), fundingPending: true });
    }

    // Store prediction if provided and round is COMMIT (5s window) or ACTIVE.
    // During ACTIVE, allow re-submission so per-round flips (UP↔DOWN) are
    // captured server-side before the round resolves.
    if (input.prediction && (match.roundPhase === "COMMIT" || (match.roundPhase === "ACTIVE" && !deadlinePassed))) {
      const predField = isPlayer1 ? "playerPrediction" : "rivalPrediction";
      const existingPred = isPlayer1 ? match.playerPrediction : match.rivalPrediction;
      const canUpdate = !existingPred || (match.roundPhase === "ACTIVE" && existingPred !== input.prediction);

      if (canUpdate) {
        const updateField: Record<string, "UP" | "DOWN"> = {};
        updateField[predField] = input.prediction;
        const atomicUpdate = await Match.findOneAndUpdate(
          { _id: match._id, roundPhase: match.roundPhase },
          { $set: updateField },
          { new: true },
        );
        if (atomicUpdate) {
          match.playerPrediction = atomicUpdate.playerPrediction;
          match.rivalPrediction = atomicUpdate.rivalPrediction;
        }
      }
    }

    // ── COMMIT → ACTIVE TRANSITION ────────────────────────────────────────
    // The 5s commit window is where the player picks Attack (UP) / Defend
    // (DOWN). The moment the prediction arrives (or the commit deadline
    // expires with the default call), the round transitions to the 10s
    // ACTIVE combat window: the entry YES-mid is locked, and the round
    // escrow receives an on-chain stakeRound.
    if (match.roundPhase === "COMMIT") {
      const commitDeadlinePassed = now.getTime() > match.roundDeadline.getTime();
      // Hold: neither prediction submitted nor deadline passed yet — the
      // client shows the commit UI countdown.
      if (!commitDeadlinePassed && !input.prediction) {
        return Response.json(buildState(match, now));
      }

      // Atomic COMMIT → ACTIVE claim (only one request wins)
      const pred = input.prediction ?? match.playerPrediction ?? "UP";
      const commitClaim = await Match.findOneAndUpdate(
        { _id: match._id, roundPhase: "COMMIT", currentRound: match.currentRound, status: "ACTIVE" },
        {
          $set: {
            roundPhase: "ACTIVE",
            [isPlayer1 ? "playerPrediction" : "rivalPrediction"]: pred,
            roundDeadline: new Date(now.getTime() + ROUND_TIMINGS.ROUND_DURATION_MS + ROUND_TIMINGS.LOCK_MS),
          },
        },
        { new: true },
      );
      if (!commitClaim) {
        // Another request already claimed — return fresh state
        const fresh = await Match.findById(match._id);
        return Response.json(buildState(fresh!, now));
      }

      // Capture the entry YES-mid for this round + PIN the arena window this
      // round FIRST. The player's real stake goes into THIS market, and the
      // round resolves against THIS market's real protocol outcome — one window,
      // one resolution, one stake.
      const asset = (commitClaim.priceModel?.asset ?? commitClaim.predictionAsset ?? "BTC") as "BTC" | "ETH";
      let entryPrice = 0;
      let pinnedArena: ArenaRef | null = null;
      try {
        pinnedArena = await ecArenaForRound(commitClaim, asset, commitClaim.currentRound - 1, { preferBook: true });
        if (pinnedArena) {
          const q = await readArenaPrice(pinnedArena);
          if (q.yesPrice && q.yesPrice > 0) entryPrice = q.yesPrice;
        }
      } catch (err) {
        console.warn(`[predict] entry price capture failed for commit round ${commitClaim.currentRound}`, err);
      }
      // Store the entry price on the match so resolveRound can compare
      // exit vs entry.
      await Match.findByIdAndUpdate(match._id, {
        $set: {
          [`priceModel.checkpoints.${commitClaim.currentRound - 1}.entryPrice`]: entryPrice,
        },
      });

      // Per-round REAL stake on DreamDEX (fire-and-forget): the operator places
      // the player's actual BUY_YES/BUY_NO market order in the pinned window via
      // the SDK trader (escrowing collateral direct to the pool). A failed stake
      // never blocks the match — the round still resolves off the real protocol
      // result.
      if (pinnedArena && commitClaim.playerAmountPerRound) {
        const stakeRaw = BigInt(Math.round(commitClaim.playerAmountPerRound * 10 ** EC_COLLATERAL_DECIMALS));
        stakePlayerRoundOnDreamDEX(pinnedArena, commitClaim.playerAddress, pred, stakeRaw)
          .then(({ txHash }) => {
            if (!txHash) return;
            return Match.updateOne(
              { _id: match._id },
              { $set: { [`priceModel.checkpoints.${commitClaim.currentRound - 1}.stakeTxHash`]: txHash } },
            );
          })
          .catch(() => {});
      }

      const fresh = await Match.findById(match._id);
      return Response.json(buildState(fresh!, now));
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
      // The round is the fixed ~10s combat window (commit at start, settle at
      // end). The stake was placed on the pinned arena at commit; the round
      // settles after the 10s window via resolveArenaOutcome — the protocol's
      // winningOutcome when it has already been posted, else the commit→round-
      // end price direction. The stake itself settles on-chain when the window
      // later closes; the round never waits on the full venue window.
      const waitMs = claim.roundDeadline.getTime() - now.getTime();
      if (waitMs > 0 && process.env.DREAMDUEL_FAST_ROUNDS !== "1") {
        await Match.findOneAndUpdate(
          { _id: match._id, roundPhase: "EXECUTING" },
          { $set: { roundPhase: "ACTIVE" } },
        );
        return Response.json({
          ...buildState(claim, now),
          waitingForOpponent: isPvP,
          roundLocked: false,
          msUntilResolve: Math.max(0, waitMs),
        });
      }

      if (isPvP) {
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
            resolvedAt: now,
          };
          const nextDeadline = new Date(now.getTime() + ROUND_TIMINGS.COMMIT_DURATION_MS);
          const nextStatus = claim.currentRound >= claim.totalRounds ? "COMPLETED" : "ACTIVE";
          const nextRoundPhase: RoundPhase = claim.currentRound >= claim.totalRounds ? "REVEALED" : "COMMIT";

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
        const { roundRecord, newPlayerScore, newRivalScore, newPlayerHP, newRivalHP, newPlayerStreak, newRivalStreak, matchDecided, winner } = result;

        const nextDeadline = new Date(now.getTime() + ROUND_TIMINGS.COMMIT_DURATION_MS);
        const nextStatus = matchDecided ? "COMPLETED" : "ACTIVE";
        const nextRoundPhase: RoundPhase = matchDecided ? "REVEALED" : "COMMIT";

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
              // One fixed match-level reference price (the first arena read),
              // NEVER overwritten, so every round resolves against the SAME
              // MOVING EC mid — real venue flow produces UP/DOWN instead of a
              // perpetual mid==anchor draw.
              arenaOpen: claim.priceModel?.arenaOpen ?? claim.priceModel?.entryPrice ?? roundRecord.startPrice ?? 0,
              checkpoints: [...(Array.isArray(claim.priceModel?.checkpoints) ? claim.priceModel.checkpoints : []), {
                roundNum: roundRecord.roundNum,
                startPrice: roundRecord.startPrice ?? 0,
                endPrice: roundRecord.endPrice ?? 0,
                prices: roundRecord.prices ?? [roundRecord.startPrice ?? 0, roundRecord.endPrice ?? 0],
                actual: roundRecord.actual,
              }],
            },
            ...(matchDecided ? {
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

        // Idempotent stats update for completed matches. Combat matches are
        // stats/rank/bragging only — money settles once on the EC position, not
        // here.
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
          resolvedAt: now,
        };

        const lastRoundNum = match.currentRound;
        const decided = lastRoundNum >= match.totalRounds || (claim.playerHP === 0 && claim.rivalHP === 0);
        const nextDeadline = new Date(now.getTime() + ROUND_TIMINGS.COMMIT_DURATION_MS);
        const nextRoundPhase: RoundPhase = decided ? "REVEALED" : "COMMIT";
        const nextStatus = decided ? "COMPLETED" : "ACTIVE";

        await Match.findByIdAndUpdate(match._id, {
          $push: { rounds: failRound },
          $set: {
            roundPhase: nextRoundPhase,
            status: nextStatus,
            playerPrediction: claim.playerPrediction,
            rivalPrediction: claim.rivalPrediction,
            ...(decided ? {
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
          return Response.json({ ...buildState(finalized!, now), executionFailed: true, error: "round resolution failed, round recorded as no-op" });
        }
        return Response.json({ ...buildState(updated!, now), executionFailed: true, error: "round resolution failed, round recorded as no-op" });
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
  funded?: boolean;
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
  // The client-facing round anchor is the same window-open YES seed the server
  // resolves rounds against (never the USD spot entryPrice, which is a different
  // scale). Fall back to the last real close, then the arena open.
  const windowOpen = match.priceModel?.arenaOpen ?? (match.priceModel?.arena as any)?.open;
  const prevRound = rounds.length > 0 ? rounds[rounds.length - 1] : undefined;
  const currentOpen = match.currentRound === 1
    ? (windowOpen || prevRound?.endPrice || 0)
    : (prevRound?.endPrice ?? windowOpen ?? 0);
  const currentCheckpoint = match.roundPhase === "ACTIVE" && match.status === "ACTIVE"
    ? {
        startPrice: currentOpen,
        endPrice: currentOpen,
        prices: currentOpen > 0 ? [currentOpen] : [],
        actual: "FLAT" as const,
      }
    : undefined;

  // The EC position is the financial layer — its amount is FIXED for the whole
  // 15-minute window and does not change between rounds. Report it as a
  // constant so the client never shows per-round P&L moving (money settles once
  // on the position, never per round).
  const fixedBalance = match.positionAmount ?? 0;

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
    funded: !!match.funded,
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
    playerBalance: fixedBalance,
    rivalBalance: fixedBalance,
    playerStartBalance: fixedBalance,
    rivalStartBalance: fixedBalance,
    lastRound,
  };
}
