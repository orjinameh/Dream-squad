import { connectToDatabase } from "@/db/connect";
import { Match, ROUND_TIMINGS, type RoundPhase, type RoundRecord, type StatsProcessedStatus } from "@/db/models/Match";
import { PlayerStats } from "@/db/models/PlayerStats";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { getPvpWinPoints } from "@/lib/rank";
import { readArenaPrice, resolveArenaOutcome, type ArenaRef } from "@/lib/ec/executor";
import { ecArenaForMatch, ecArenaForRound } from "@/lib/ec/arena";
import { stakePlayerRoundOnDreamDEX } from "@/lib/ec/staker";
import { payoutTusdc } from "@/lib/ec/payout";
import { collectRoundFunding } from "@/lib/ec/funding";
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

// Combat damage model: BASE_DAMAGE plus streak bonuses (critical at streak 3+).
// Resolved rounds currently pass decisiveness 0, so damage is 15 / 18 / 25 by
// streak — the move-amplitude bonus below stays dormant until wired.
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

// EC judge note: rounds are decided by the EC YES-mid MOVE (Second-20 exit vs
// Second-10 entry) with an epsilon band — any genuine tick movement counts, and
// a literally untouched book is an honest FLAT draw (stake back). See
// resolveArenaOutcome in @/lib/ec/executor.
// Maximum time the COMMIT handler will wait for the operator's stake
// transaction to confirm before giving up (client holds on the COMMIT screen
// with a staking overlay until then — the battle must not start unconfirmed).
const STAKE_GATE_TIMEOUT_MS = 60_000;
// A staking lock older than this is treated as a crashed gate and may be
// claimed by the next COMMIT submit. Covers stake (60s) + funding (45s) legs
// with headroom; the lock is released on every normal exit long before this.
const STAKING_LOCK_MS = 150_000;

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
  playerPnL: number;
  rivalPnL: number;
  newPlayerBalance: number;
  newRivalBalance: number;
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

    // Instant per-round P&L (paper credit in MongoDB — no on-chain movement
    // here). A correct call wins the stake; a wrong call loses it; an honest
    // FLAT (no market move) is a push — stake back, 0. FLAT must never drain
    // the balance, or every no-move round silently taxes the player.
    const stakeAmount = match.playerAmountPerRound ?? 1;
    const rivalStakeAmount = match.rivalAmountPerRound ?? 1;
    const playerPnL = isFlat ? 0 : playerCorrect ? stakeAmount : -stakeAmount;
    const rivalPnL = isFlat ? 0 : rivalCorrect ? rivalStakeAmount : -rivalStakeAmount;
    const prevPlayerBalance = match.playerBalance ?? match.playerStartBalance ?? 100;
    const prevRivalBalance = match.rivalBalance ?? match.rivalStartBalance ?? 100;
    const newPlayerBalance = Math.max(0, prevPlayerBalance + playerPnL);
    const newRivalBalance = Math.max(0, prevRivalBalance + rivalPnL);

    // Stamp P&L and live balance onto the round record for display.
    roundRecord.playerPnL = playerPnL;
    roundRecord.rivalPnL = rivalPnL;
    roundRecord.playerBalance = newPlayerBalance;
    roundRecord.rivalBalance = newRivalBalance;

    return {
      roundRecord, newPlayerScore, newRivalScore, newPlayerHP, newRivalHP,
      newPlayerStreak, newRivalStreak, matchDecided, winner,
      playerPnL, rivalPnL, newPlayerBalance, newRivalBalance,
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
      $set: { lastPlayedAt: now, favoriteChar: match.playerChar, balance: match.playerBalance ?? match.playerStartBalance ?? 100 },
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
        $set: { lastPlayedAt: now, favoriteChar: match.player2Char || "dreamer", balance: match.rivalBalance ?? match.rivalStartBalance ?? 100 },
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

/**
 * GAME OVER — [THE SINGLE FINAL PAYOUT]
 * Once the 7th round finishes (or a KO lands), credit is already paper-settled
 * per round in MongoDB (playerBalance). This fires ONE real tUSDC transfer per
 * net-positive player delivering the total match winnings to their primary
 * wallet. Fire-and-forget: the round flow never blocks on it; the record
 * (finalPayoutTxHash / rivalFinalPayoutTxHash) makes it idempotent, and the
 * background worker recoups the operator's venue shares off-line later via
 * settleRoundStakes().
 */
async function maybeFinalPayout(matchId: string): Promise<void> {
  try {
    const m = await Match.findById(matchId).lean();
    if (!m || m.status !== "COMPLETED") return;
    const jobs: { key: string; amountKey: string; addr: string; net: number }[] = [];
    const pStart = m.playerStartBalance ?? m.positionAmount ?? 0;
    const pNet = (m.playerBalance ?? pStart) - pStart;
    if (pNet > 1e-6 && m.playerAddress) {
      jobs.push({ key: "finalPayoutTxHash", amountKey: "finalPayoutAmount", addr: m.playerAddress, net: pNet });
    }
    if (m.opponentType === "player" && m.player2Address) {
      const rStart = m.rivalStartBalance ?? m.positionAmount ?? 0;
      const rNet = (m.rivalBalance ?? rStart) - rStart;
      if (rNet > 1e-6) jobs.push({ key: "rivalFinalPayoutTxHash", amountKey: "rivalFinalPayoutAmount", addr: m.player2Address, net: rNet });
    }
    for (const job of jobs) {
      // The payout MUST go to the match's recorded player wallet — never the
      // operator, never a ghost, never zero. Validate before signing.
      if (!isAddress(job.addr) || job.addr === "0x0000000000000000000000000000000000000000") {
        console.error(`[payout] match=${matchId} refusing payout to invalid address ${job.addr}`);
        continue;
      }
      const claimed = await Match.updateOne(
        { _id: matchId, [job.key]: { $exists: false } },
        { $set: { [job.key]: "PENDING", [job.amountKey]: job.net } },
      );
      if (claimed.modifiedCount !== 1) continue; // already paid / in flight
      console.log(`[payout] match=${matchId} paying ${job.net} tUSDC to player ${job.addr}`);
      payoutTusdc(job.addr as `0x${string}`, job.net)
        .then(({ txHash, error }) => {
          if (error || !txHash) {
            console.error(`[payout] final payout failed for ${job.addr}:`, error ?? "no tx");
            Match.updateOne({ _id: matchId }, { $unset: { [job.key]: 1 } }).catch((e) =>
              console.error("[payout] failed to clear pending payout", e),
            );
            return;
          }
          console.log(`[payout] final match payout ${job.net} tUSDC to ${job.addr} — tx ${txHash}`);
          Match.updateOne({ _id: matchId }, { $set: { [job.key]: txHash } }).catch((e) =>
            console.error("[payout] failed to record final payout", e),
          );
        })
        .catch((err) => {
          console.error("[payout] final payout error", err);
          Match.updateOne({ _id: matchId }, { $unset: { [job.key]: 1 } }).catch(() => {});
        });
    }
  } catch (err) {
    console.error("[payout] maybeFinalPayout failed", err);
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
    // Contact heartbeat: abandonment requires INACTIVITY, so every
    // authenticated touch refreshes lastSeenAt (indexed _id write).
    await Match.updateOne({ _id: match._id }, { $set: { lastSeenAt: now } }).catch(() => {});
    if (match.status !== "ACTIVE") {
      return Response.json(buildState(match, now));
    }

    const isPvP = match.opponentType === "player";
    const isPlayer1 = normalizeAddress(match.playerAddress) === address;
    const isPlayer2 = isPvP && match.player2Address && normalizeAddress(match.player2Address) === address;
    if (!isPlayer1 && !isPlayer2) return jsonError(403, "not a player in this match");

    const isBot = match.opponentType === "bot";
    const deadlineMs = match.roundDeadline ? new Date(match.roundDeadline).getTime() : NaN;
    const deadlinePassed = Number.isFinite(deadlineMs) && now.getTime() > deadlineMs;
    const isExpired = deadlinePassed && match.roundPhase === "ACTIVE";

    // Per-round financial model: `funded` is authoritative at create (true for
    // every match — there is no separate player→escrow pre-funding to wait on;
    // each round's stake custodies through the venue via the operator). A legacy
    // ghost-funded match retains its flag but is never held by it.

    // Traditional binary lock: predictions are accepted ONLY during COMMIT
    // (the 10s pick window). Once the round is ACTIVE (the 10s trade duration),
    // the position is locked — no flips. An ACTIVE payload never rewrites the
    // locked call; it only drives the resolution claim below.
    if (input.prediction && match.roundPhase === "COMMIT") {
      const predField = isPlayer1 ? "playerPrediction" : "rivalPrediction";
      const atomicUpdate = await Match.findOneAndUpdate(
        { _id: match._id, roundPhase: "COMMIT" },
        { $set: { [predField]: input.prediction } },
        { new: true },
      );
      if (atomicUpdate) {
        match.playerPrediction = atomicUpdate.playerPrediction;
        match.rivalPrediction = atomicUpdate.rivalPrediction;
      }
    }

    // ── COMMIT → ACTIVE TRANSITION — [THE SINGLE GATE] ───────────────────
    // 0s→10s COMMIT: the player picks Attack (UP) / Defend (DOWN) — one fresh
    // stake position per round (7 stakes per match, each living through its own
    // 10s battle). The background operator places that side as a real BUY_YES /
    // BUY_NO order on the pinned dreamDEX Event-Contract window HERE, and this
    // handler AWAITS the confirmation receipt before the battle countdown may
    // start. No receipt → no ACTIVE (client holds on the COMMIT staking
    // overlay and retries); the 10s battle never runs on an unconfirmed stake.
    if (match.roundPhase === "COMMIT") {
      const commitDeadlineMs = match.roundDeadline ? new Date(match.roundDeadline).getTime() : NaN;
      const commitDeadlinePassed = Number.isFinite(commitDeadlineMs) && now.getTime() > commitDeadlineMs;
      // Hold: neither prediction submitted nor deadline passed yet — the
      // client shows the commit UI countdown.
      if (!commitDeadlinePassed && !input.prediction) {
        return Response.json(buildState(match, now));
      }

      const pred = input.prediction ?? match.playerPrediction ?? "UP";

      // Re-read: if another request already locked this round, do NOT stake
      // again — return its fresh state (prevents double-staking the same round
      // when two COMMIT submits race).
      const gateCheck = await Match.findById(match._id).lean();
      if (!gateCheck || gateCheck.status !== "ACTIVE") {
        return Response.json(buildState((await Match.findById(match._id))!, now));
      }
      if (gateCheck.roundPhase !== "COMMIT" || gateCheck.currentRound !== match.currentRound) {
        const fresh = await Match.findById(match._id);
        return Response.json(buildState(fresh!, now));
      }
      const cpIdx = gateCheck.currentRound - 1;

      // ── STAKING LOCK (confirm-strict, time-lenient): exactly one gate
      // execution may place this round's stake+funding. A concurrent COMMIT
      // submit sees the fresh lock and waits (staking-pending) instead of
      // double-spending — so client retries during slow confirmations are
      // always safe. Stale locks (> STAKING_LOCK_MS, crashed gate) are
      // claimable. The lock releases on every exit path below.
      const lockRes = await Match.updateOne(
        {
          _id: match._id,
          roundPhase: "COMMIT",
          currentRound: match.currentRound,
          status: "ACTIVE",
          $or: [
            { [`priceModel.checkpoints.${cpIdx}.staking`]: { $ne: true } },
            { [`priceModel.checkpoints.${cpIdx}.stakingAt`]: { $lt: new Date(Date.now() - STAKING_LOCK_MS).toISOString() } },
          ],
        },
        { $set: { [`priceModel.checkpoints.${cpIdx}.staking`]: true, [`priceModel.checkpoints.${cpIdx}.stakingAt`]: now.toISOString() } },
      );
      if (lockRes.modifiedCount !== 1) {
        // Either moved on (return it) or another gate is confirming (wait).
        const fresh = await Match.findById(match._id).lean();
        if (!fresh || fresh.roundPhase !== "COMMIT" || fresh.currentRound !== match.currentRound) {
          return Response.json(buildState((await Match.findById(match._id))!, now));
        }
        return Response.json({ ...buildState(fresh as any, now), staking: true });
      }
      const releaseLock = () =>
        Match.updateOne(
          { _id: match._id },
          { $set: { [`priceModel.checkpoints.${cpIdx}.staking`]: false } },
        ).catch(() => {});

      // Pin the arena window + capture the Second-10 entry YES-mid FIRST. The
      // player's real stake goes into THIS market, and the round resolves at
      // Second 20 against THIS market — one window, one resolution, one stake.
      const asset = (gateCheck.priceModel?.asset ?? gateCheck.predictionAsset ?? "BTC") as "BTC" | "ETH";
      let entryPrice = 0;
      let pinnedArena: ArenaRef | null = null;
      try {
        pinnedArena = await ecArenaForRound(gateCheck as any, asset, gateCheck.currentRound - 1, { preferBook: true });
        if (pinnedArena) {
          const q = await readArenaPrice(pinnedArena);
          if (q.yesPrice && q.yesPrice > 0) entryPrice = q.yesPrice;
        }
      } catch (err) {
        console.warn(`[predict] entry price capture failed for commit round ${gateCheck.currentRound}`, err);
      }
      await Match.findByIdAndUpdate(match._id, {
        $set: {
          [`priceModel.checkpoints.${gateCheck.currentRound - 1}.entryPrice`]: entryPrice,
        },
      });

      // ── THE GATE: place + await the real stake before opening the battle.
      // Skipped only when there is nothing real to stake (no live arena/entry
      // → paper FLAT round) or when staking is disabled (fast tests / no
      // operator key in dev) — otherwise the round MUST NOT start unconfirmed.
      // Idempotent: a COMMIT retry reuses the already-recorded stake instead of
      // double-staking the round.
      const stakeConfigured = !!process.env.OPERATOR_PRIVATE_KEY && process.env.DREAMDUEL_FAST_ROUNDS !== "1";
      const gateFresh = await Match.findById(match._id).lean();
      const existingCp = gateFresh?.priceModel?.checkpoints?.[cpIdx] as
        | { stakeTxHash?: string; stakeSide?: "UP" | "DOWN"; stakeQty?: string; stakeCostRaw?: string; fundTxHash?: string }
        | undefined;
      let stakeTxHash: string | null = existingCp?.stakeTxHash ?? null;
      let stakeQty: bigint | null = null;
      let stakeCost: bigint | null = null;
      try {
        if (existingCp?.stakeQty != null) stakeQty = BigInt(existingCp.stakeQty);
        if (existingCp?.stakeCostRaw != null) stakeCost = BigInt(existingCp.stakeCostRaw);
      } catch { /* corrupt record — re-stake below */ stakeTxHash = null; }
      if (!stakeTxHash && pinnedArena && entryPrice > 0 && gateCheck.playerAmountPerRound) {
        if (stakeConfigured) {
          const stakeRaw = BigInt(Math.round(gateCheck.playerAmountPerRound * 10 ** EC_COLLATERAL_DECIMALS));
          const staked: { txHash: string | null; error?: string; costRaw?: bigint; filledQuantity?: bigint } = await Promise.race([
            stakePlayerRoundOnDreamDEX(pinnedArena, gateCheck.playerAddress, pred, stakeRaw),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("stake confirmation timed out")), STAKE_GATE_TIMEOUT_MS),
            ),
          ]).catch((err) => ({ txHash: null as string | null, error: err instanceof Error ? err.message : String(err) }));
          if (!staked.txHash) {
            // Gate closed: release the lock and hold COMMIT so the client
            // retries instead of fighting an unstaked round.
            console.error(`[predict] stake gate failed for round ${gateCheck.currentRound}: ${staked.error ?? "no fill"}`);
            await releaseLock();
            return Response.json(
              { ...buildState((await Match.findById(match._id))!, now), stakeFailed: true, error: `stake not confirmed: ${staked.error ?? "no fill"} — retrying` },
              { status: 502 },
            );
          }
          stakeTxHash = staked.txHash;
          stakeQty = staked.filledQuantity ?? null;
          stakeCost = staked.costRaw ?? null;
        } else if (process.env.DREAMDUEL_FAST_ROUNDS !== "1") {
          console.warn("[predict] stake gate open without operator key — paper round (dev only)");
        }
      }

      // ── FUNDING LEG: draw the confirmed stake's cost from the player's
      // operator approval (per-match consumption). The approval from the
      // POSITION screen covers amount × rounds; each COMMIT gate spends one
      // round's share, so a finished match exhausts it and replay needs a
      // fresh approval. Receipt awaited — no fund, no battle.
      // (PvP stakes are currently placed for player 1's side only, so the draw
      // follows the stake: player 1's approval. Player-2 staking is unchanged.)
      let fundTxHash: string | null = existingCp?.fundTxHash ?? null;
      if (!fundTxHash && stakeTxHash && stakeConfigured) {
        const fundAmount = stakeCost ?? BigInt(Math.round(gateCheck.playerAmountPerRound * 10 ** EC_COLLATERAL_DECIMALS));
        if (fundAmount > 0n) {
          const funded = await collectRoundFunding(gateCheck.playerAddress as `0x${string}`, fundAmount);
          if (!funded.txHash) {
            console.error(`[predict] funding gate failed for round ${gateCheck.currentRound}: ${funded.error ?? "unknown"}`);
            await releaseLock();
            return Response.json(
              { ...buildState((await Match.findById(match._id))!, now), stakeFailed: true, error: `funding not confirmed: ${funded.error ?? "transfer failed"} — retrying` },
              { status: 502 },
            );
          }
          fundTxHash = funded.txHash;
          await Match.updateOne(
            { _id: match._id },
            { $set: { [`priceModel.checkpoints.${cpIdx}.fundTxHash`]: fundTxHash, [`priceModel.checkpoints.${cpIdx}.fundCostRaw`]: fundAmount.toString() } },
          ).catch((e) => console.error("[predict] failed to record funding", e));
        }
      }

      // Atomic COMMIT → ACTIVE claim (only the lock holder wins — it releases
      // the lock in the same write). The battle deadline starts NOW — at
      // confirmation time — so the strict 10s window always measures Second 10
      // → Second 20 from the confirmed stake. That 10s is the ONLY rigid clock.
      const stakeSet: Record<string, unknown> = {};
      if (stakeTxHash) {
        stakeSet[`priceModel.checkpoints.${cpIdx}.stakeTxHash`] = stakeTxHash;
        stakeSet[`priceModel.checkpoints.${cpIdx}.stakeSide`] = pred;
        if (stakeQty != null) stakeSet[`priceModel.checkpoints.${cpIdx}.stakeQty`] = stakeQty.toString();
        if (stakeCost != null) stakeSet[`priceModel.checkpoints.${cpIdx}.stakeCostRaw`] = stakeCost.toString();
      }
      const commitClaim = await Match.findOneAndUpdate(
        { _id: match._id, roundPhase: "COMMIT", currentRound: match.currentRound, status: "ACTIVE" },
        {
          $set: {
            roundPhase: "ACTIVE",
            [isPlayer1 ? "playerPrediction" : "rivalPrediction"]: pred,
            roundDeadline: new Date(Date.now() + ROUND_TIMINGS.ROUND_DURATION_MS + ROUND_TIMINGS.LOCK_MS),
            [`priceModel.checkpoints.${cpIdx}.staking`]: false,
            ...stakeSet,
          },
        },
        { new: true },
      );
      if (!commitClaim) {
        // Lost the claim (phase moved under us) — release the lock and return
        // fresh state; never advance a round that isn't ours.
        await releaseLock();
        const fresh = await Match.findById(match._id);
        return Response.json(buildState(fresh!, now));
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
      const claimDeadlineMs = claim.roundDeadline ? new Date(claim.roundDeadline).getTime() : NaN;
      const waitMs = Number.isFinite(claimDeadlineMs) ? claimDeadlineMs - now.getTime() : 0;
      if (waitMs > 0 && process.env.DREAMDUEL_FAST_ROUNDS !== "1") {
        // Reset to ACTIVE so the predict loop can re-claim once the deadline
        // passes. The atomic findOneAndUpdate claim prevents concurrent execution.
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
            await Match.findByIdAndUpdate(match._id, { $set: { statsProcessed: "COMPLETE" as StatsProcessedStatus } });
            // GAME OVER single final payout (draw → nets ≤ 0 → no-op inside).
            void maybeFinalPayout(match._id.toString()).catch((e) => console.error("[payout] game-over payout failed", e));
          }
          return Response.json(buildState(updated!, now));
        }
      }

      // Execute and resolve
      try {
        const result = await resolveRound(claim, now);
        const { roundRecord, newPlayerScore, newRivalScore, newPlayerHP, newRivalHP, newPlayerStreak, newRivalStreak, matchDecided, winner, playerPnL, rivalPnL, newPlayerBalance, newRivalBalance } = result;

        const nextDeadline = new Date(now.getTime() + ROUND_TIMINGS.COMMIT_DURATION_MS);
        const nextStatus = matchDecided ? "COMPLETED" : "ACTIVE";
        const nextRoundPhase: RoundPhase = matchDecided ? "REVEALED" : "COMMIT";

        const allRounds = [...(claim.rounds as any[]), roundRecord];

        // Preserve per-round stake/audit fields written at the COMMIT gate
        // (stakeTxHash/stakeSide/stakeQty/stakeCostRaw/arena/entryPrice) by
        // MERGING into this round's checkpoint slot. (Appending would duplicate
        // the slot and misalign every later round's entry/arena.)
        const prevCps: any[] = Array.isArray(claim.priceModel?.checkpoints) ? [...claim.priceModel.checkpoints] : [];
        const cpSlot = roundRecord.roundNum - 1;
        const prevCp = prevCps[cpSlot] ?? {};
        while (prevCps.length <= cpSlot) prevCps.push({});
        prevCps[cpSlot] = {
          ...prevCp,
          roundNum: roundRecord.roundNum,
          startPrice: roundRecord.startPrice ?? (prevCp as any).startPrice ?? 0,
          endPrice: roundRecord.endPrice ?? (prevCp as any).endPrice ?? 0,
          prices: roundRecord.prices ?? (prevCp as any).prices ?? [roundRecord.startPrice ?? 0, roundRecord.endPrice ?? 0],
          actual: roundRecord.actual,
          arena: (prevCp as any).arena ?? roundRecord.arena,
          entryPrice: (prevCp as any).entryPrice ?? roundRecord.startPrice,
        };
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
            playerBalance: newPlayerBalance,
            rivalBalance: newRivalBalance,
            ...(matchDecided ? { playerFinalBalance: newPlayerBalance, rivalFinalBalance: newRivalBalance } : {}),
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
              arena: claim.priceModel?.arena,
              checkpoints: prevCps,
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

        // ROUND RESOLUTION (Second 20) — [INSTANT DATABASE CREDIT ONLY]
        // Paper-credit the round PnL straight into MongoDB (playerBalance /
        // rivalBalance). Deliberately NO on-chain transfer or redemption here —
        // the single real tUSDC payout fires once at GAME OVER below, and the
        // worker recoups venue shares off-line via settleRoundStakes().

        // Idempotent stats update for completed matches. Combat matches are
        // stats/rank/bragging only — money settles once on the EC position, not
        // here.
        if (matchDecided) {
          const matchForStats = { ...(typeof claim.toObject === "function" ? claim.toObject() : claim), rounds: allRounds };
          await updatePlayerStatsAtomic(matchForStats, allRounds, winner, now);
            await Match.findByIdAndUpdate(match._id, { $set: { statsProcessed: "COMPLETE" as StatsProcessedStatus } });
          // GAME OVER single final payout (fire-and-forget, idempotent).
          void maybeFinalPayout(match._id.toString()).catch((e) => console.error("[payout] game-over payout failed", e));
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
        const decided = lastRoundNum >= match.totalRounds || claim.playerHP <= 0 || claim.rivalHP <= 0;
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
          // GAME OVER single final payout (draw → nets ≤ 0 → no-op inside).
          void maybeFinalPayout(match._id.toString()).catch((e) => console.error("[payout] game-over payout failed", e));
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
  // GAME OVER single final payout (tUSDC tx hash once mined, "PENDING" in flight)
  finalPayoutTxHash?: string | null;
  finalPayoutAmount?: number | null;
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
    winner: match.winner ?? "draw",
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
    // Live per-round balance from the match document (updated after each round
    // by resolveRound). Falls back to the fixed position amount for legacy matches.
    playerBalance: match.playerBalance ?? match.playerStartBalance ?? fixedBalance,
    rivalBalance: match.rivalBalance ?? match.rivalStartBalance ?? fixedBalance,
    playerStartBalance: match.playerStartBalance ?? fixedBalance,
    rivalStartBalance: match.rivalStartBalance ?? fixedBalance,
    // GAME OVER single final payout state (paper credit until then).
    finalPayoutTxHash: match.finalPayoutTxHash ?? null,
    finalPayoutAmount: match.finalPayoutAmount ?? null,
    lastRound,
  };
}
