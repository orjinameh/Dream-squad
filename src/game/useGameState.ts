"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { type CharacterDef, CHARACTERS, RIVAL_NAMES } from "./characters";
import { type GamePhase, type GameMode, type Prediction, type RoundResult, type PredictionConfig, type BotDifficulty, type FighterState, type CombatPhase, type TradeMarket, DEFAULT_MODE, DEFAULT_TRADE_MARKET, PREDICTIONS } from "./types";
import {
  useMultiplayer,
  type ConnectionStatus,
} from "./useMultiplayer";
import { useAccount } from "wagmi";

const LOCK_DURATION = 1200;
const REVEAL_DURATION = 1500;
const IMPACT_DURATION = 1400;
const MATCH_INTRO_DURATION = 2000;
const ROUND_TRANSITION_DELAY = 800;
const ROUND_TIME = (globalThis as any).__ROUND_TIME__ ?? 10;

const MAX_HP = 100;

const WINDUP_MS = 400;
const STRIKE_MS = 300;
const HITSTOP_MS = 80;
const IMPACT_MS = 300;
const KNOCKBACK_MS = 300;
const RECOVERY_MS = 200;
const CLASH_MS = 600;

// Harmless visual-only randomness — NEVER used for game outcomes
function visualCoinFlip(): "LEFT" | "RIGHT" {
  return Math.random() < 0.5 ? "LEFT" : "RIGHT";
}

export interface GameActions {
  goToHome: () => void;
  goToMarketSelect: () => void;
  goToCharSelect: () => void;
  goToLeaderboard: () => void;
  goToProfile: () => void;
  goToMatchHistory: () => void;
  goToStakeHistory: () => void;
  goToMatchDetail: (matchId: string) => void;
  selectMarket: (market: TradeMarket) => void;
  selectChar: (char: CharacterDef) => void;
  confirmDuel: () => void;
  selectPrediction: (pred: PredictionConfig) => void;
  setMatchPrediction: (pred: "UP" | "DOWN") => void;
  selectDifficulty: (diff: BotDifficulty) => void;
  selectAmount: (amount: number) => void;
  makePrediction: (pred: "UP" | "DOWN") => void;
  rematch: () => void;
  joinMatchmaking: (rounds: number) => void;
  startPvPMatch: (matchId: string) => void;
  setReady: () => void;
  startDuel: () => void;
  cancelMatchmaking: () => void;
  fightBotInstead: () => void;
  goToPosition: () => void;
  goToMatchType: () => void;
  openPosition: (opts: { direction: "UP" | "DOWN"; market: string; amount: number; positionId: string; windowId: string; stakeTxHash: string | null; escrowAddress?: string | null; entryPrice?: string | null }) => void;
  changePosition: () => void;
}

export interface GameHook {
  phase: GamePhase;
  mode: GameMode | null;
  marketSymbol: string;
  playerChar: CharacterDef | null;
  rivalChar: CharacterDef | null;
  rivalName: string;
  currentRound: number;
  totalRounds: number;
  playerScore: number;
  rivalScore: number;
  playerStreak: number;
  rivalStreak: number;
  timeLeft: number;
  playerPrediction: Prediction;
  lockedCall: "UP" | "DOWN" | null;
  roundResult: RoundResult | null;
  roundHistory: RoundResult[];
  hitEffect: "none" | "player-hit" | "rival-hit" | "both-hit";
  shakeScreen: boolean;
  showStreak: string | null;
  playerCharState: FighterState;
  rivalCharState: FighterState;
  matchId: string | null;
  isBotMatch: boolean;
  funded: boolean;
  fundingHeld: boolean;
  connectionStatus: ConnectionStatus;
  pingMs: number;
  predictionStatus: "idle" | "selected" | "submitting" | "confirmed" | "error";
  lastError: string | null;
  connectionMessage: string | null;
  isReconnecting: boolean;
  selectedPrediction: PredictionConfig;
  botDifficulty: BotDifficulty;
  selectedAmount: number;
  executionStatus: "idle" | "executing" | "success" | "failed" | "retrying";
  executionError: string | null;
  lastTxHash: string | null;
  playerHP: number;
  rivalHP: number;
  maxHP: number;
  combatPhase: CombatPhase;
  lastDamage: { amount: number; target: "player" | "rival"; isCritical: boolean } | null;
  isFinalRound: boolean;
  koOverlay: string | null;
  selectedMatchId: string | null;
  // Coherent market series for the current round
  market?: {
    asset: string;
    startPrice: number;
    endPrice: number;
    prices: number[];
    actual: "UP" | "DOWN" | "FLAT";
  };
  // Trading balances (STT)
  playerBalance: number;
  rivalBalance: number;
  playerStartBalance: number;
  rivalStartBalance: number;
  // Per-player independent trade amount (STT) — each player's own stake.
  playerAmountPerRound?: number;
  rivalAmountPerRound?: number;
  // Active EC POSITION (financial layer). Combat matches ride this window.
  positionWindowId: string | null;
  positionDirection: "UP" | "DOWN" | null;
  positionAmount: number | null;
  positionMarket: string | null;
  positionStakeTxHash: string | null;
  positionEscrowAddress: string | null;
  positionEntryPrice: string | null;
  positionSettlementOutcome: "WON" | "LOST" | null;
  positionWonPositions: {
    id: string; direction: "UP" | "DOWN"; market: string; amount: number;
    windowId: string; escrowAddress: string; stakeAmountFormatted: string | null; claimable: boolean;
  }[];
  reloadPosition: () => void;
  hasActivePosition: boolean;
  actions: GameActions;
}

export function useGameState(): GameHook {
  const mp = useMultiplayer();
  const { address } = useAccount();

  // Sync wallet address into multiplayer for predict submissions. A connected
  // wallet is required to play (the UI gates entry behind it), so this only
  // wires through the real address.
  useEffect(() => {
    if (address) mp.actions.setAddress(address);
  }, [address, mp.actions]);

  const [phase, setPhase] = useState<GamePhase>("HOME");
  const [mode, setMode] = useState<GameMode>(DEFAULT_MODE);
  const [marketSymbol, setMarketSymbol] = useState<string>(DEFAULT_TRADE_MARKET.symbol);
  const [playerChar, setPlayerChar] = useState<CharacterDef | null>(null);
  const [rivalChar, setRivalChar] = useState<CharacterDef | null>(null);
  const [rivalName, setRivalName] = useState("");
  const [playerStreak, setPlayerStreak] = useState(0);
  const [rivalStreak, setRivalStreak] = useState(0);
  const [timeLeft, setTimeLeft] = useState(ROUND_TIME);
  const [playerPrediction, setPlayerPrediction] = useState<Prediction>(null);
  const [localPrediction, setLocalPrediction] = useState<Prediction>(null);
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null);
  const [roundHistory, setRoundHistory] = useState<RoundResult[]>([]);
  const [hitEffect, setHitEffect] = useState<"none" | "player-hit" | "rival-hit" | "both-hit">("none");
  const [shakeScreen, setShakeScreen] = useState(false);
  const [showStreak, setShowStreak] = useState<string | null>(null);
  const [playerCharState, setPlayerCharState] = useState<FighterState>("idle");
  const [rivalCharState, setRivalCharState] = useState<FighterState>("idle");
  const [playerScore, setPlayerScore] = useState(0);
  const [rivalScore, setRivalScore] = useState(0);
  const [predictionUIStatus, setPredictionUIStatus] = useState<"idle" | "selected" | "submitting" | "confirmed">("idle");
  const [isBotMatch, setIsBotMatch] = useState(true);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [displayRound, setDisplayRound] = useState(1);
  const [selectedPrediction, setSelectedPrediction] = useState<PredictionConfig>(PREDICTIONS[0]);
  const [botDifficulty, setBotDifficulty] = useState<BotDifficulty>("normal");
  const [selectedAmount, setSelectedAmount] = useState<number>(1);
  // The player's single, locked call for the whole match — chosen once on the
  // pre-match prediction screen. It is carried across every round and can never
  // change once the match starts (no per-round re-picking).
  const [storedPrediction, setStoredPrediction] = useState<"UP" | "DOWN" | null>(null);
  const [executionStatus, setExecutionStatus] = useState<"idle" | "executing" | "success" | "failed" | "retrying">("idle");
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);
  const [playerHP, setPlayerHP] = useState(MAX_HP);
  const [rivalHP, setRivalHP] = useState(MAX_HP);
  const [combatPhase, setCombatPhase] = useState<CombatPhase>("idle");
  const [lastDamage, setLastDamage] = useState<{ amount: number; target: "player" | "rival"; isCritical: boolean } | null>(null);
  const [isFinalRound, setIsFinalRound] = useState(false);
  const [koOverlay, setKoOverlay] = useState<string | null>(null);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);

  // Active EC POSITION — the single financial stake the match rides on.
  const [positionWindowId, setPositionWindowId] = useState<string | null>(null);
  const [positionDirection, setPositionDirection] = useState<"UP" | "DOWN" | null>(null);
  const [positionAmount, setPositionAmount] = useState<number | null>(null);
  const [positionMarket, setPositionMarket] = useState<string | null>(null);
  const [positionStakeTxHash, setPositionStakeTxHash] = useState<string | null>(null);
  const [positionId, setPositionId] = useState<string | null>(null);
  const [positionEscrowAddress, setPositionEscrowAddress] = useState<string | null>(null);
  const [positionEntryPrice, setPositionEntryPrice] = useState<string | null>(null);
  const [positionSettlementOutcome, setPositionSettlementOutcome] = useState<"WON" | "LOST" | null>(null);
  const [positionWonPositions, setPositionWonPositions] = useState<{
    id: string; direction: "UP" | "DOWN"; market: string; amount: number;
    windowId: string; escrowAddress: string; stakeAmountFormatted: string | null; claimable: boolean;
  }[]>([]);
  const [positionReloadTick, setPositionReloadTick] = useState(0);
  const reloadPosition = useCallback(() => setPositionReloadTick((t) => t + 1), []);
  const hasActivePosition = Boolean(positionWindowId && positionDirection);

  // Load the wallet's EC POSITION (active, else latest settled) so a WON stake
  // stays reachable across reloads for withdraw. Doesn't clobber a just-opened
  // position (that is written by openPosition below).
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/position?address=${address}`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          position?: {
            windowId?: string | null;
            direction?: "UP" | "DOWN" | null;
            amount?: number | null;
            market?: string | null;
            stakeTxHash?: string | null;
            status?: string | null;
            escrowAddress?: string | null;
            entryPrice?: string | null;
            winPayout?: string | null;
            settlement?: { outcome?: "WON" | "LOST" | null } | null;
            onchain?: { settled?: boolean; won?: number | string } | null;
          } | null;
          wonPositions?: {
            id: string; direction: "UP" | "DOWN"; market: string; amount: number;
            windowId: string; escrowAddress: string; stakeAmountFormatted: string | null; claimable: boolean;
          }[];
        } | null;
        if (!data) return;
        const p = data.position;
        if (!p || cancelled || positionWindowId) return;
        if (p.windowId && p.direction) {
          setPositionWindowId(p.windowId);
          setPositionDirection(p.direction);
          setPositionAmount(p.amount ?? null);
          setPositionMarket(p.market ?? null);
          setPositionStakeTxHash(p.stakeTxHash ?? null);
          setPositionEscrowAddress(p.escrowAddress ?? null);
          setPositionEntryPrice(p.entryPrice ?? null);
          setPositionSettlementOutcome(p.settlement?.outcome ?? null);
          setPositionWonPositions(data.wonPositions ?? []);
        }
      } catch {
        /* position load is best-effort */
      }
    })();
    return () => { cancelled = true; };
  }, [address, positionWindowId, positionReloadTick]);

  const animFrameRef = useRef<number>(0);
  const phaseTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const roundProcessedRef = useRef<number[]>([]);
  const botTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pvpTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const enteredFromIntroRef = useRef(false);
  const modeRef = useRef<GameMode | null>(null);
  const localPredictionRef = useRef<Prediction>(null);
  const storedPredictionRef = useRef<"UP" | "DOWN" | null>(null);
  const phaseRef = useRef<GamePhase>("HOME");
  const playerHPRef = useRef(MAX_HP);
  const rivalHPRef = useRef(MAX_HP);

  // Round lifecycle guards
  const roundIdentityRef = useRef<string | null>(null);
  const roundPhaseRef = useRef<"LOCKED" | "SUBMITTING" | "WAITING_SERVER" | "ANIMATING" | "RESOLVED">("LOCKED");
  const activeRoundNumRef = useRef<number>(0);
  const lastServerPhaseKeyRef = useRef<string | null>(null);

  // Deterministic local price model + match metadata, captured at match
  // creation. Lets the client resolve a round LOCALLY (no server round-trip)
  // so a round can never freeze on "predictions locked" waiting on the server.
  const localMatchRef = useRef<{
    matchId: string;
    asset: string;
    totalRounds: number;
  } | null>(null);

  // Keep refs in sync for use inside intervals/timeouts
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { localPredictionRef.current = localPrediction; }, [localPrediction]);

  const clearAllTimers = useCallback(() => {
    phaseTimersRef.current.forEach(clearTimeout);
    phaseTimersRef.current = [];
    if (botTimerRef.current) { clearInterval(botTimerRef.current); botTimerRef.current = null; }
    if (pvpTimerRef.current) { clearInterval(pvpTimerRef.current); pvpTimerRef.current = null; }
  }, []);

  useEffect(() => () => { clearAllTimers(); cancelAnimationFrame(animFrameRef.current); }, [clearAllTimers]);

  const scheduleTimer = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    phaseTimersRef.current.push(t);
    return t;
  }, []);

  // --- SERVER-AUTHORITATIVE COMBAT ANIMATION SEQUENCER ---
  // Receives authoritative result from server, plays animation only
  const playCombatAnimation = useCallback((lastRound: any, totalRounds: number, serverPlayerHP: number, serverRivalHP: number, serverPlayerScore: number, serverRivalScore: number) => {
    if (roundPhaseRef.current === "ANIMATING" || roundPhaseRef.current === "RESOLVED") return;
    roundPhaseRef.current = "ANIMATING";

    // Sync all combat state from server
    playerHPRef.current = serverPlayerHP;
    rivalHPRef.current = serverRivalHP;
    setPlayerHP(serverPlayerHP);
    setRivalHP(serverRivalHP);
    setPlayerScore(serverPlayerScore);
    setRivalScore(serverRivalScore);

    const isDraw = lastRound.playerCorrect === lastRound.rivalCorrect;
    const playerCorrect = lastRound.playerCorrect;
    const damage = lastRound.damage ?? 0;
    const isCritical = lastRound.isCritical ?? false;
    const knockout = lastRound.knockout ?? false;

    // Sync streaks from server (server tracks these)
    // Client just needs to know for streak display
    const sPlayerCorrect = playerCorrect;
    if (sPlayerCorrect) {
      const streak = (mp.state.serverState?.playerStreak ?? 0);
      if (streak >= 4) setShowStreak("UNSTOPPABLE");
      else if (streak === 3) setShowStreak("ON_FIRE");
      else if (streak === 2) setShowStreak("COMBO");
      else setShowStreak("STRIKE");
    } else {
      setShowStreak(null);
    }

    // Build round result for display
    const result: RoundResult = {
      roundNum: lastRound.roundNum,
      actual: lastRound.actual,
      playerPredicted: lastRound.playerPrediction,
      rivalPredicted: lastRound.rivalPrediction,
      playerCorrect,
      rivalCorrect: lastRound.rivalCorrect,
      playerDamage: lastRound.playerDamage ?? 0,
      rivalDamage: lastRound.rivalDamage ?? 0,
      isCritical,
      isDraw,
      knockout,
      startPrice: lastRound.startPrice,
      endPrice: lastRound.endPrice,
      prices: lastRound.prices,
      asset: lastRound.asset,
      playerPnL: lastRound.playerPnL,
      rivalPnL: lastRound.rivalPnL,
      playerExecution: lastRound.playerExecution,
      rivalExecution: lastRound.rivalExecution,
    };
    setRoundResult(result);
    // Idempotent append: playCombatAnimation can be reached from BOTH
    // advanceAfterSubmit AND the server-sync effect for the same round, which
    // used to push duplicate rounds -> roundHistory grew past totalRounds (e.g.
    // 11 icons for a 7-round match). Dedup by roundNum so it never overflows.
    setRoundHistory((prev) => {
      if (prev.some((r) => r.roundNum === result.roundNum)) return prev;
      return [...prev, result];
    });

    // Extract tx hash for display
    const pExec = lastRound.playerExecution;
    if (pExec?.txHash) setLastTxHash(pExec.txHash);
    if (pExec?.status === "EXECUTED") setExecutionStatus("success");
    else if (pExec?.status === "FAILED") { setExecutionStatus("failed"); setExecutionError(pExec.error ?? "Execution failed"); }

    setCombatPhase("windup");
    setLastDamage(null);

    if (isDraw) {
      setPlayerCharState("windup");
      setRivalCharState("windup");
      scheduleTimer(() => {
        setCombatPhase("clash");
        setPlayerCharState("block");
        setRivalCharState("block");
        setShakeScreen(true);
        scheduleTimer(() => setShakeScreen(false), 200);
      }, WINDUP_MS / 2);
      scheduleTimer(() => {
        setCombatPhase("recovery");
        setPlayerCharState("idle");
        setRivalCharState("idle");
      }, WINDUP_MS / 2 + CLASH_MS);
      scheduleTimer(() => {
        setCombatPhase("idle");
        setHitEffect("none");
        proceedToReveal(lastRound.roundNum, totalRounds, knockout, serverPlayerScore, serverRivalScore);
      }, WINDUP_MS / 2 + CLASH_MS + RECOVERY_MS);
    } else {
      const attackerWins = playerCorrect;
      const setAttacker = attackerWins ? setPlayerCharState : setRivalCharState;
      const setDefender = attackerWins ? setRivalCharState : setPlayerCharState;
      const damageTarget: "player" | "rival" = attackerWins ? "rival" : "player";

      setAttacker("windup");
      setDefender("locked");

      scheduleTimer(() => {
        setCombatPhase("strike");
        setAttacker("attack");
        setShakeScreen(true);
        scheduleTimer(() => setShakeScreen(false), 150);
      }, WINDUP_MS);

      scheduleTimer(() => {
        setCombatPhase("impact");
        setDefender(isCritical ? "stunned" : "hit");
        setAttacker("attack");
        setLastDamage({ amount: damage, target: damageTarget, isCritical });
        setHitEffect(attackerWins ? "rival-hit" : "player-hit");
      }, WINDUP_MS + STRIKE_MS);

      scheduleTimer(() => {
        setCombatPhase("recovery");
        setDefender("knockback");
        setAttacker("idle");
      }, WINDUP_MS + STRIKE_MS + HITSTOP_MS + IMPACT_MS);

      scheduleTimer(() => {
        setDefender("idle");
        setCombatPhase("idle");
        setHitEffect("none");
        proceedToReveal(lastRound.roundNum, totalRounds, knockout, serverPlayerScore, serverRivalScore);
      }, WINDUP_MS + STRIKE_MS + HITSTOP_MS + IMPACT_MS + KNOCKBACK_MS);
    }
  }, [scheduleTimer, mp.state.serverState]);

  // --- REVEAL/NEXT-ROUND after combat animation ---
  const proceedToReveal = useCallback((rNum: number, totalRounds: number, ko: boolean, pScore: number, rScore: number) => {
    scheduleTimer(() => setPhase("ROUND_REVEAL"), 200);
    scheduleTimer(() => { setPhase("ROUND_IMPACT"); setHitEffect("none"); }, 200 + REVEAL_DURATION);
    scheduleTimer(() => {
      roundPhaseRef.current = "RESOLVED";
      if (ko) {
        const playerWon = pScore > rScore;
        setKoOverlay(playerWon ? `${playerChar?.name ?? "PLAYER"} WINS!` : `${rivalName} WINS!`);
        setCombatPhase("ko");
        setPlayerCharState(playerWon ? "victory" : "defeat");
        setRivalCharState(playerWon ? "defeat" : "victory");
        setShakeScreen(true);
        scheduleTimer(() => setShakeScreen(false), 500);
        scheduleTimer(() => { setPhase("MATCH_RESULT"); setKoOverlay(null); }, 2000);
      } else if (rNum >= totalRounds) {
        setPhase("MATCH_RESULT");
        const won = pScore > rScore;
        const draw = pScore === rScore;
        setPlayerCharState(won ? "victory" : draw ? "idle" : "defeat");
        setRivalCharState(won ? "defeat" : draw ? "idle" : "victory");
      } else {
        setPlayerCharState("idle"); setRivalCharState("idle");
        setRoundResult(null); setLastDamage(null);
        // Per-round binary semantics: the player's pick is NOT locked to the
        // pre-match call. Carry the previous round's position forward as the new
        // round's default (so an untouched fight still resolves), but never
        // overwrite an in-progress per-round flip. The server resolves each round
        // against the per-round playerPrediction it stored, so a different
        // direction per round is a genuine 7-trades-in-1-match.
        setLocalPrediction((prev) => prev ?? storedPredictionRef.current);
        setPlayerPrediction((prev) => prev ?? storedPredictionRef.current);
        setLockedPrediction(storedPredictionRef.current);
        setPredictionUIStatus("idle");
        const nextRound = rNum + 1;
        setDisplayRound(nextRound);
        setIsFinalRound(nextRound >= totalRounds);
        activeRoundNumRef.current = nextRound;
        roundPhaseRef.current = "LOCKED";
        lastServerPhaseKeyRef.current = null; // Reset to allow server sync for next round
        setPhase("ROUND_START");
        scheduleTimer(() => {
          roundIdentityRef.current = `${isBotMatch ? "bot" : "pvp"}-${nextRound}`;
          setPlayerCharState("thinking"); setRivalCharState("thinking");
          setPhase("ROUND_ACTIVE");
        }, ROUND_TRANSITION_DELAY);
      }
    }, 200 + REVEAL_DURATION + IMPACT_DURATION);
  }, [scheduleTimer, playerChar, rivalName, isBotMatch]);

  // --- ADVANCE AFTER SUBMIT ---
  // Advances the match DIRECTLY from the round-resolution response, so bot
  // matches do NOT depend on the server-poll effect to progress (that async
  // path was the source of rounds freezing). Plays the authoritative combat
  // animation; proceedToReveal moves to the next round or the result screen.
  const advanceAfterSubmit = useCallback((resp: any) => {
    const rounds = resp?.rounds ?? [];
    const lastRound = rounds[rounds.length - 1];
    if (!lastRound) return;
    if (roundProcessedRef.current.includes(lastRound.roundNum)) return; // already handled
    roundProcessedRef.current.push(lastRound.roundNum);

    const pExec = lastRound.playerExecution;
    if (pExec?.txHash) setLastTxHash(pExec.txHash);
    if (pExec?.status === "EXECUTED") setExecutionStatus("success");
    else if (pExec?.status === "FAILED") { setExecutionStatus("failed"); setExecutionError(pExec.error ?? "Execution failed"); }
    else if (pExec?.status) setExecutionStatus("success");

    playCombatAnimation(
      lastRound,
      resp.totalRounds,
      resp.playerHP ?? playerHP,
      resp.rivalHP ?? rivalHP,
      resp.playerScore ?? playerScore,
      resp.rivalScore ?? rivalScore,
    );
  }, [playCombatAnimation, playerHP, rivalHP, playerScore, rivalScore]);

  // --- FORCED LOCAL ADVANCE (freeze-proof fallback) ---
  // If the server predict fails/hangs, never leave the round stuck on
  // "predictions locked". Resolve this round locally as a defensive draw (no
  // damage) and advance to the next round. Server resolution remains the
  // primary path; this only guards the rare failure so the game always flows.
  const forceLocalAdvance = useCallback(() => {
    if (roundPhaseRef.current !== "SUBMITTING") return;
    if (roundProcessedRef.current.includes(activeRoundNumRef.current)) return;
    roundProcessedRef.current.push(activeRoundNumRef.current);
    roundPhaseRef.current = "WAITING_SERVER";

    const m = localMatchRef.current;
    const rNum = activeRoundNumRef.current;
    setExecutionStatus("success");
    playCombatAnimation({
      roundNum: rNum,
      actual: "FLAT",
      playerPrediction: localPredictionRef.current ?? "UP",
      rivalPrediction: (localPredictionRef.current === "UP" ? "DOWN" : "UP"),
      playerCorrect: true,
      rivalCorrect: true,
      playerDamage: 0,
      rivalDamage: 0,
      isCritical: false,
      knockout: false,
      startPrice: 0,
      endPrice: 0,
      prices: [],
      asset: m?.asset ?? "BTC",
      playerPnL: 0,
      rivalPnL: 0,
      playerExecution: null,
      rivalExecution: null,
      damage: 0,
    }, m?.totalRounds ?? 7, playerHP, rivalHP, playerScore, rivalScore);
  }, [playCombatAnimation, playerHP, rivalHP, playerScore, rivalScore]);

  // --- BOT COUNTDOWN TIMER ---
  // Visual countdown only. Server resolves the round via predict endpoint.
  useEffect(() => {
    if (!isBotMatch || phase !== "ROUND_ACTIVE") return;
    // GHOST FUNDING GATE (hard): the one-time deposit MUST be confirmed before
    // any round clock can run. Only `serverState.funded === true` (set when
    // /api/matches/ghost lands) lets the timer start. Anything else — unfunded,
    // missing matchId, or a stale pre-fix match with no funding info — holds the
    // round. Because the timer never starts, `attemptSubmit`/`forceLocalAdvance`
    // can never fabricate a round and auto-advance an unfunded fight.
    if (mp.state.serverState?.funded !== true) return;
    if (botTimerRef.current) return;

    const deadline = Date.now() + ROUND_TIME * 1000;
    setTimeLeft(ROUND_TIME);
    let resolved = false;

    const tick = () => {
      const remaining = Math.max(0, (deadline - Date.now()) / 1000);
      setTimeLeft(+remaining.toFixed(2));

      if (remaining <= 0 && !resolved) {
        resolved = true;
        if (botTimerRef.current) { clearInterval(botTimerRef.current); botTimerRef.current = null; }

        // LOCK: freeze UI
        setPhase("ROUND_LOCKED");
        setPlayerCharState("locked");
        setRivalCharState("locked");

        // The player's actual move for this round is their locked call (or a
        // per-round flip). NEVER invent a random UP/DOWN for them — the round
        // must resolve against the input the player actually made. If they made
        // no call, submit a no-move so the server records an honest no-op (no
        // hit) at the deadline instead of a fabricated call that could land an
        // unearned hit.

        // Submit to server — server resolves everything. Use a BOUNDED retry
        // so a transient network/5xx failure cannot leave the round frozen at
        // ROUND_LOCKED. After a few attempts, force a local advance so the
        // game ALWAYS flows to the next round (never freezes).
        const pred = (localPredictionRef.current as "UP" | "DOWN" | null) ?? undefined;
        setExecutionStatus("executing");
        roundPhaseRef.current = "SUBMITTING";

        let submitAttempts = 0;
        const retryOrForce = (): void => {
          submitAttempts += 1;
          if (submitAttempts >= 6) {
            forceLocalAdvance();
            return;
          }
          scheduleTimer(attemptSubmit, 600);
        };

        const attemptSubmit = (): void => {
          mp.actions.submitPrediction(pred).then((d) => {
            if (d && d.rounds && d.rounds.length) {
              setExecutionStatus("success");
              roundPhaseRef.current = "WAITING_SERVER";
              advanceAfterSubmit(d);
            } else if (roundPhaseRef.current === "SUBMITTING") {
              // No resolved round yet — retry after a short delay
              retryOrForce();
            }
          }).catch(() => {
            if (roundPhaseRef.current === "SUBMITTING") {
              // Wait for the server's sticky-close to pass, then retry
              retryOrForce();
            }
          });
        };
        attemptSubmit();
      }
    };

    botTimerRef.current = setInterval(tick, 50) as unknown as ReturnType<typeof setInterval>;
    return () => {
      if (botTimerRef.current) { clearInterval(botTimerRef.current); botTimerRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBotMatch, phase, mp.state.serverState?.funded]);
  // --- PVP ROUND COUNTDOWN + SUBMIT ---
  // PvP rounds resolve server-authoritatively via the predict route, which
  // claims the round, waiting for both players to submit (or resolving after
  // the deadline). This effect (a) keeps the UI countdown in lockstep with the
  // shared server deadline, (b) locks the UI at timeout, and (c) makes sure the
  // player's side is always submitted — auto-picking if they never tapped. It
  // keeps ticking through ROUND_LOCKED and re-submits if the round is still
  // unresolved past its deadline (e.g. both players submitted just before the
  // close and the server momentarily reverted to ACTIVE), so a round can never
  // deadlock. The resolved outcome/animation flows back via the server-sync
  // effect below, which advances the phase and tears this timer down.
  useEffect(() => {
    if (isBotMatch) return;
    if (phase !== "ROUND_ACTIVE" && phase !== "ROUND_LOCKED") return;
    const trackedRound = activeRoundNumRef.current;
    if (trackedRound <= 0) return;

    let lastSubmitAt = 0;
    let lastSubmitPred: "UP" | "DOWN" | null = null;
    const SUBMIT_BACKOFF_MS = 1200;

    const check = () => {
      if (phaseRef.current !== "ROUND_ACTIVE" && phaseRef.current !== "ROUND_LOCKED") return;
      if (activeRoundNumRef.current !== trackedRound) return;
      const remaining = mp.actions.getTimeRemaining();
      setTimeLeft(+Math.max(0, remaining).toFixed(2));

      if (remaining > 0) return;
      // Deadline elapsed — lock the UI once
      if (phaseRef.current === "ROUND_ACTIVE") {
        phaseRef.current = "ROUND_LOCKED";
        setPhase("ROUND_LOCKED");
        setPlayerCharState("locked");
        setRivalCharState("locked");
      }

      // Make sure this player's prediction is stored server-side.
      const pred = localPredictionRef.current as "UP" | "DOWN";
      if (lastSubmitPred !== pred || Date.now() - lastSubmitAt >= SUBMIT_BACKOFF_MS) {
        lastSubmitPred = pred;
        lastSubmitAt = Date.now();
        roundPhaseRef.current = "SUBMITTING";
        setExecutionStatus("executing");
        mp.actions.submitPrediction(pred).then((d) => {
          if (d && d.rounds && d.rounds.length) {
            setExecutionStatus("success");
            roundPhaseRef.current = "WAITING_SERVER";
            // Round resolved — the server-sync effect will play it and advance.
          } else {
            // Not resolved yet (waiting on opponent / reverted) — keep retrying.
            roundPhaseRef.current = "LOCKED";
          }
        }).catch(() => {
          roundPhaseRef.current = "LOCKED";
        });
      }
    };

    check();
    pvpTimerRef.current = setInterval(check, 200) as unknown as ReturnType<typeof setInterval>;
    return () => {
      if (pvpTimerRef.current) { clearInterval(pvpTimerRef.current); pvpTimerRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBotMatch, phase, mp.actions]);

  // --- SERVER-SYNCED MULTIPLAYER ---
  // Responds to server state changes for both bot and PvP matches
  useEffect(() => {
    const ss = mp.state.serverState;

    // ── REHYDRATE roundHistory from the AUTHORITATIVE server rounds[] ────────
    // The server is the source of truth for every resolved round. The client's
    // local `roundHistory` is append-only during a live session, so a mid-match
    // reconnect (or a completed match reached via polling) would otherwise MISS
    // any rounds that resolved while we weren't looking. Rebuild it here by
    // mapping each server RoundRecord to the same RoundResult shape used by
    // playCombatAnimation, preserving any rounds already played locally.
    if (ss?.rounds?.length) {
      const serverRounds: any[] = ss.rounds;
      const haveRounds = serverRounds.map((r) => r.roundNum);
      setRoundHistory((prev) => {
        const seen = new Set(prev.map((r) => r.roundNum));
        const missing = serverRounds.filter((r) => !seen.has(r.roundNum));
        if (!missing.length) return prev;
        const hydrated = missing.map((lastRound) => {
          const result: RoundResult = {
            roundNum: lastRound.roundNum,
            actual: lastRound.actual,
            playerPredicted: lastRound.playerPrediction,
            rivalPredicted: lastRound.rivalPrediction,
            playerCorrect: lastRound.playerCorrect,
            rivalCorrect: lastRound.rivalCorrect,
            playerDamage: lastRound.playerDamage ?? 0,
            rivalDamage: lastRound.rivalDamage ?? 0,
            isCritical: lastRound.isCritical ?? false,
            isDraw: lastRound.playerCorrect === lastRound.rivalCorrect,
            knockout: lastRound.knockout ?? false,
            startPrice: lastRound.startPrice,
            endPrice: lastRound.endPrice,
            prices: lastRound.prices,
            asset: lastRound.asset,
            playerPnL: lastRound.playerPnL,
            rivalPnL: lastRound.rivalPnL,
            playerExecution: lastRound.playerExecution,
            rivalExecution: lastRound.rivalExecution,
          };
          return result;
        });
        return [...prev, ...hydrated];
      });
    }

    // PvP: hydrate the player/rival character objects from the server-provided
    // charId strings. In PvP startPvPMatch never sets rivalChar, so without this
    // the ArenaScreen would render RetroCharacter with a null char and crash
    // on char.colors the instant the round opens.
    if (!isBotMatch && ss?.playerChar) {
      const pc = CHARACTERS.find((c) => c.id === ss.playerChar);
      if (pc && pc.id !== playerChar?.id) setPlayerChar(pc);
    }
    if (!isBotMatch && ss?.rivalChar) {
      const rc = CHARACTERS.find((c) => c.id === ss.rivalChar);
      if (rc && rc.id !== rivalChar?.id) setRivalChar(rc);
      if (ss.rivalName && ss.rivalName !== rivalName) setRivalName(ss.rivalName);
    }
    if (!ss || ss.status !== "ACTIVE") {
      // Check for completed match
      if (ss && ss.status === "COMPLETED" && phase !== "MATCH_RESULT") {
        // Match completed — show result
        const won = ss.playerScore > ss.rivalScore;
        const draw = ss.playerScore === ss.rivalScore;
        setPlayerScore(ss.playerScore);
        setRivalScore(ss.rivalScore);
        setPlayerHP(ss.playerHP);
        setRivalHP(ss.rivalHP);
        setPlayerCharState(won ? "victory" : draw ? "idle" : "defeat");
        setRivalCharState(won ? "defeat" : draw ? "idle" : "victory");
        setPhase("MATCH_RESULT");
      } else if (ss && ss.status === "ABANDONED") {
        // A stuck/stale match was abandoned server-side — leave it quietly.
        clearAllTimers(); mp.actions.reset(); setPhase("HOME");
      }
      return;
    }

    // Sync HP from server on every poll
    if (ss.playerHP !== undefined) {
      setPlayerHP(ss.playerHP);
      playerHPRef.current = ss.playerHP;
    }
    if (ss.rivalHP !== undefined) {
      setRivalHP(ss.rivalHP);
      rivalHPRef.current = ss.rivalHP;
    }

    // Track server phase transitions. If we're still waiting in READY_UP (e.g.
    // a rejoin into a match that already went ACTIVE, or the READY_UP timer
    // clobbered an earlier ROUND_ACTIVE open), do NOT let the phaseKey guard
    // swallow the open — we must keep re-triggering until we leave READY_UP.
    const phaseKey = `${ss.currentRound}-${ss.roundPhase}`;
    if (phaseKey === lastServerPhaseKeyRef.current && phase !== "READY_UP") return;
    if (phaseKey !== lastServerPhaseKeyRef.current) lastServerPhaseKeyRef.current = phaseKey;

    const lastRound = ss.rounds?.[ss.rounds.length - 1];
    // PvP only: bot matches advance deterministically via advanceAfterSubmit on
    // the submission response — the poll effect must NOT also advance them.
    const isPvpNewRound = !isBotMatch && !!lastRound && !roundProcessedRef.current.includes(lastRound.roundNum);

    // PvP: a newly-resolved round has appeared via polling. Play the
    // authoritative combat animation and let proceedToReveal advance.
    if (isPvpNewRound) {
      roundProcessedRef.current.push(lastRound.roundNum);
      playCombatAnimation(lastRound, ss.totalRounds, ss.playerHP, ss.rivalHP, ss.playerScore, ss.rivalScore);
      return;
    }

    // Open the current ACTIVE round only when we're NOT already mid-round
    // (i.e. not currently ROUND_START/ACTIVE/LOCKED/EXECUTING/REVEAL/IMPACT).
    // This covers the fresh first-round open AND mid-match reconnect, while
    // never clobbering proceedToReveal's own advance between rounds.
    const midRound = phase === "ROUND_START" || phase === "ROUND_ACTIVE" || phase === "ROUND_LOCKED"
      || phase === "ROUND_EXECUTING" || phase === "ROUND_REVEAL" || phase === "ROUND_IMPACT";
    // STAKE GATE: while the player is on the READY_UP stake screen, NEVER
    // auto-advance into the fight just because the server already opened round
    // 1. The only way out of READY_UP is the explicit START DUEL action, which
    // moves to MATCH_INTRO/ROUND_START itself. Otherwise the poll effect would
    // kick the player out of the stake screen within seconds (the server opens
    // round 1 ACTIVE the instant createMatch runs) — letting the match start
    // before the stake is confirmed.
    if (phase === "READY_UP") return;
    // GHOST FUNDING GATE: never open a bot round unless funding is confirmed —
    // hold on the FUND screen until the one-time deposit lands (server refuses to
    // resolve anyway). PvP has no ghost and is unaffected.
    if (isBotMatch && mp.state.serverState?.funded !== true && ss.roundPhase === "ACTIVE") return;
    if (ss.roundPhase === "ACTIVE" && !midRound) {
      roundIdentityRef.current = `${isBotMatch ? "bot" : "pvp"}-${ss.currentRound}`;
      activeRoundNumRef.current = ss.currentRound;
      roundPhaseRef.current = "LOCKED";
      setLocalPrediction(storedPredictionRef.current);
      setPlayerPrediction(storedPredictionRef.current);
      setLockedPrediction(storedPredictionRef.current);
      setPredictionUIStatus("idle");
      setRoundResult(null);
      setLastDamage(null);
      setPlayerCharState("thinking");
      setRivalCharState("thinking");
      setDisplayRound(ss.currentRound);
      setIsFinalRound(ss.currentRound >= ss.totalRounds);
      setPlayerScore(ss.playerScore);
      setRivalScore(ss.rivalScore);

      const wasIntro = enteredFromIntroRef.current;
      enteredFromIntroRef.current = false;
      scheduleTimer(() => setPhase("ROUND_ACTIVE"), wasIntro ? MATCH_INTRO_DURATION : ROUND_TRANSITION_DELAY);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mp.state.serverState, phase, isBotMatch, scheduleTimer, playCombatAnimation]);

  // Server-synced countdown for PvP
  useEffect(() => {
    if (isBotMatch || phase !== "ROUND_ACTIVE") return;
    let running = true;
    const getTimeRemaining = mp.actions.getTimeRemaining;
    const tick = () => { if (!running) return; const remaining = getTimeRemaining(); setTimeLeft(+remaining.toFixed(2)); animFrameRef.current = requestAnimationFrame(tick); };
    tick();
    return () => { running = false; cancelAnimationFrame(animFrameRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, isBotMatch]);

  // Connection status messages
  useEffect(() => {
    if (isBotMatch) { setConnectionMessage(null); return; }
    if (mp.state.connectionStatus === "reconnecting") setConnectionMessage("CONNECTION LOST\nRECONNECTING...");
    else setConnectionMessage(null);
  }, [mp.state.connectionStatus, isBotMatch]);

  // --- MATCH CREATION ---
  const startMatch = useCallback(async () => {
    setPhase("MATCH_INTRO");
    roundProcessedRef.current = [];
    roundIdentityRef.current = "bot-1";
    roundPhaseRef.current = "LOCKED";
    activeRoundNumRef.current = 1;
    lastServerPhaseKeyRef.current = null;

    const rc = CHARACTERS.filter((c) => c.id !== playerChar?.id);
    const rival = rc[Math.floor(Math.random() * rc.length)];
    const rn = RIVAL_NAMES[Math.floor(Math.random() * RIVAL_NAMES.length)];
    setRivalChar(rival);
    setRivalName(rn);

    // Flows that reach MATCH_TYPE without passing through character selection
    // (e.g. POSITION -> MATCH_TYPE -> BOT MATCH) leave `playerChar` unset. Give
    // it a default so every arena render (intro/round/result) has a character —
    // previously the null `playerChar!` crashed the HUD with a client error.
    if (!playerChar) setPlayerChar(CHARACTERS[0]);

    setPlayerScore(0); setRivalScore(0);
    setPlayerStreak(0); setRivalStreak(0);
    setRoundHistory([]); setRoundResult(null);
    // Seed round 1 with the locked pre-match call.
    setPlayerPrediction(storedPredictionRef.current); setLocalPrediction(storedPredictionRef.current); setLockedPrediction(storedPredictionRef.current);
    setHitEffect("none"); setShakeScreen(false);
    setShowStreak(null);
    setPlayerCharState("idle"); setRivalCharState("idle");
    setTimeLeft(ROUND_TIME);
    setDisplayRound(1);
    setIsBotMatch(true);
    setExecutionStatus("idle"); setExecutionError(null); setLastTxHash(null);
    setPlayerHP(MAX_HP); setRivalHP(MAX_HP);
    playerHPRef.current = MAX_HP; rivalHPRef.current = MAX_HP;
    setCombatPhase("idle"); setLastDamage(null); setKoOverlay(null);
    setIsFinalRound((mode?.rounds ?? 7) <= 1);
    enteredFromIntroRef.current = true;

    // Create server-side match — store matchId for bot matches too. If the match
    // cannot be created (e.g. still in an old ACTIVE match), there is no matchId,
    // so the ghost has nothing to fund and the fight CANNOT begin. Surface the
    // error and hold on the start screen instead of silently entering a fight
    // that can never be funded.
    let matchCreated = false;
    try {
      const res = await mp.actions.createMatch({
        playerAddress: address || "0x0000000000000000000000000000000000000000",
        playerChar: playerChar?.id ?? "dreamer",
        rivalName: rn,
        rivalChar: rival.id,
        mode: mode?.id ?? "duel",
        totalRounds: mode?.rounds ?? 7,
        marketSymbol,
        predictionAsset: selectedPrediction?.asset,
        amountPerRound: selectedAmount,
        positionId: positionId ?? undefined,
      });
      if (res?.matchId) {
        matchCreated = true;
        mp.actions.reconnectToMatch(res.matchId);
      }
    } catch (e) {
      const msg = (e as Error)?.message || "failed to create match";
      setExecutionStatus("failed");
      setExecutionError(msg);
    }

    if (!matchCreated) {
      // Hold: no match means no ghost funding, so the duel may not start. Stay on
      // the start/ready screen where the error is shown; the player must resolve
      // the blocker (e.g. finish their active match) before fighting.
      return;
    }

    // The EC POSITION is already staked on the POSITION screen (the financial
    // layer). No per-match stake gate: advance straight into the fight.
    scheduleTimer(() => {
      setPhase("ROUND_START");
      scheduleTimer(() => {
        setPhase("ROUND_ACTIVE");
        setPlayerCharState("thinking");
        setRivalCharState("thinking");
      }, ROUND_TRANSITION_DELAY);
    }, MATCH_INTRO_DURATION);
  }, [playerChar, mode, marketSymbol, scheduleTimer, address, mp.actions, positionId]);
  // Advance from the general stake gate into the fight (bot path only — PvP
  // advances via the server round-open once both players READY UP).
  const startDuel = useCallback(() => {
    if (phase !== "READY_UP" || !isBotMatch) return;
    setPhase("MATCH_INTRO");
    scheduleTimer(() => {
      setPhase("ROUND_START");
      scheduleTimer(() => {
        setPhase("ROUND_ACTIVE");
        setPlayerCharState("thinking");
        setRivalCharState("thinking");
      }, ROUND_TRANSITION_DELAY);
    }, MATCH_INTRO_DURATION);
  }, [phase, isBotMatch, scheduleTimer]);

  // --- PREDICTION ---
  // Records the player's chosen position locally but does NOT submit/resolve
  // it. The round stays open so the position can be repositioned (changed)
  // freely until the round closes — only the bot countdown timer commits and
  // resolves the round at timeout. This matches binary-trading semantics:
  // you hold one position per round and can flip it until the market closes.
  const [lockedPrediction, setLockedPrediction] = useState<"UP" | "DOWN" | null>(null);

  // Per-round binary semantics: you HOLD one position per round and can FLIP it
  // UP<->DOWN any number of times while the round is ACTIVE (before the round
  // lock timer commits it). The default call for a round is the previous round's
  // (or the pre-match) position, so a fight still resolves if you don't touch
  // it; changing it here re-submits the NEW call for the CURRENT round to the
  // server (which stores/updates `playerPrediction` while the round is ACTIVE).
  const makePrediction = useCallback((_pred: "UP" | "DOWN") => {
    if (phase !== "ROUND_ACTIVE") return;
    if (localPrediction === _pred) return; // already holding that side
    setLocalPrediction(_pred);
    setPlayerPrediction(_pred);
    setLockedPrediction(_pred);
    setPredictionUIStatus("selected");

    if (!isBotMatch) {
      mp.actions.submitPrediction(_pred).then((d) => {
        if (d && d.rounds && d.rounds.length) {
          roundPhaseRef.current = "WAITING_SERVER";
          setExecutionStatus("success");
        } else {
          roundPhaseRef.current = "LOCKED";
        }
      }).catch(() => {
        roundPhaseRef.current = "LOCKED";
      });
    }
  }, [phase, localPrediction, isBotMatch, mp.actions]);

  const rematch = useCallback(() => {
    clearAllTimers();
    mp.actions.reset();
    roundProcessedRef.current = [];
    roundIdentityRef.current = null;
    roundPhaseRef.current = "LOCKED";
    activeRoundNumRef.current = 0;
    lastServerPhaseKeyRef.current = null;
    setPhase("CHAR_SELECT");
    setPlayerPrediction(null); setLocalPrediction(null); setLockedPrediction(null);
    setStoredPrediction(null); storedPredictionRef.current = null;
    setRoundResult(null); setRoundHistory([]);
    setPlayerScore(0); setRivalScore(0);
    setPlayerStreak(0); setRivalStreak(0);
    setHitEffect("none"); setShakeScreen(false);
    setShowStreak(null);
    setPlayerCharState("idle"); setRivalCharState("idle");
    setPredictionUIStatus("idle"); setTimeLeft(ROUND_TIME);
    setDisplayRound(1);
    setPlayerHP(MAX_HP); setRivalHP(MAX_HP);
    playerHPRef.current = MAX_HP; rivalHPRef.current = MAX_HP;
    setCombatPhase("idle"); setLastDamage(null); setKoOverlay(null);
    setIsFinalRound(false);
  }, [clearAllTimers, mp.actions]);

  const goToHome = useCallback(() => { clearAllTimers(); mp.actions.reset(); setPhase("HOME"); roundProcessedRef.current = []; lastServerPhaseKeyRef.current = null; }, [clearAllTimers, mp.actions]);
  const goToMarketSelect = useCallback(() => { setPhase("MARKET_SELECT"); }, []);
  const goToCharSelect = useCallback(() => { clearAllTimers(); mp.actions.reset(); setPhase("CHAR_SELECT"); roundProcessedRef.current = []; lastServerPhaseKeyRef.current = null; }, [clearAllTimers, mp.actions]);
  const goToLeaderboard = useCallback(() => { window.location.href = "/leaderboard"; }, []);
  const goToProfile = useCallback(() => { setPhase("PROFILE"); }, []);
  const goToMatchHistory = useCallback(() => { setPhase("MATCH_HISTORY"); }, []);
  const goToStakeHistory = useCallback(() => { setPhase("STAKE_HISTORY"); }, []);
  const goToMatchDetail = useCallback((matchId: string) => { setSelectedMatchId(matchId); setPhase("MATCH_DETAIL"); }, []);
  const selectMarket = useCallback((m: TradeMarket) => { setMarketSymbol(m.symbol); setMode(DEFAULT_MODE); setPhase("POSITION"); }, []);
  const selectChar = useCallback((c: CharacterDef) => { setPlayerChar(c); setPhase("MATCH_TYPE"); }, []);
  const confirmDuel = useCallback(() => { setPhase("MATCH_TYPE"); }, []);

  // POSITION screen: the player stakes an EC position (UP/DOWN $X) — the single
  // financial layer. The screen POSTs /api/position and returns the windowId +
  // positionId; we store them so combat matches can reference this position.
  const goToPosition = useCallback(() => { setPhase("POSITION"); }, []);
  const goToMatchType = useCallback(() => { if (!hasActivePosition) return; setPhase("MATCH_TYPE"); }, [hasActivePosition]);
  const openPosition = useCallback((opts: { direction: "UP" | "DOWN"; market: string; amount: number; positionId: string; windowId: string; stakeTxHash: string | null; escrowAddress?: string | null; entryPrice?: string | null }) => {
    setPositionDirection(opts.direction);
    setPositionAmount(opts.amount);
    setPositionMarket(opts.market);
    setPositionId(opts.positionId);
    setPositionWindowId(opts.windowId);
    setPositionStakeTxHash(opts.stakeTxHash);
    setPositionEscrowAddress(opts.escrowAddress ?? null);
    setPositionEntryPrice(opts.entryPrice ?? null);
  }, []);
  const changePosition = useCallback(() => {
    setPositionDirection(null); setPositionAmount(null); setPositionMarket(null);
    setPositionId(null); setPositionWindowId(null); setPositionStakeTxHash(null);
    setPositionEscrowAddress(null); setPositionEntryPrice(null); setPositionSettlementOutcome(null);
    setPositionWonPositions([]);
    setPhase("POSITION");
  }, []);
  const selectPrediction = useCallback((pred: PredictionConfig) => { setSelectedPrediction(pred); }, []);
  const setMatchPrediction = useCallback((c: "UP" | "DOWN") => {
    setSelectedPrediction((prev) => ({ ...prev, prediction: c }));
    setStoredPrediction(c);
    storedPredictionRef.current = c;
  }, []);
  const selectDifficulty = useCallback((diff: BotDifficulty) => { setBotDifficulty(diff); }, []);
  const selectAmount = useCallback((amount: number) => { setSelectedAmount(amount); }, []);

  const joinMatchmaking = useCallback((selectedRounds: number) => {
    clearAllTimers();
    roundProcessedRef.current = [];
    lastServerPhaseKeyRef.current = null;
    setIsBotMatch(false);
    setMode(DEFAULT_MODE);
    setPhase("MATCHMAKING");
  }, [clearAllTimers]);

  const startPvPMatch = useCallback((pvpMatchId: string) => {
    clearAllTimers();
    roundProcessedRef.current = [];
    lastServerPhaseKeyRef.current = null;
    roundIdentityRef.current = `pvp-match-${pvpMatchId}`;
    roundPhaseRef.current = "LOCKED";
    activeRoundNumRef.current = 1;
    setIsBotMatch(false);

    mp.actions.reconnectToMatch(pvpMatchId);

    setPhase("MATCH_FOUND");
    scheduleTimer(() => { setPhase("READY_UP"); }, 2000);
  }, [clearAllTimers, mp.actions, scheduleTimer]);

  const setReady = useCallback(async () => {
    const id = mp.state.serverState?.matchId;
    if (!id || !address) return;

    await fetch("/api/matches/ready", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matchId: id,
        address: address, // Always use connected wallet
        charId: playerChar?.id ?? "dreamer",
      }),
    });
  }, [mp.state.serverState, address, playerChar]);

  const cancelMatchmaking = useCallback(() => {
    clearAllTimers();
    setPhase("HOME");
  }, [clearAllTimers]);

  const fightBotInstead = useCallback(() => {
    clearAllTimers();
    mp.actions.reset();
    setIsBotMatch(true);
    startMatch();
  }, [clearAllTimers, mp.actions, startMatch]);

  const connectionDisplay: ConnectionStatus = isBotMatch ? "local" : mp.state.connectionStatus;

  return {
    phase, mode, marketSymbol, playerChar, rivalChar, rivalName,
    currentRound: displayRound,
    totalRounds: isBotMatch ? (mode.rounds ?? 7) : (mp.state.serverState?.totalRounds ?? mode.rounds ?? 7),
    playerScore: mp.state.serverState?.playerScore ?? playerScore,
    rivalScore: mp.state.serverState?.rivalScore ?? rivalScore,
    playerStreak: mp.state.serverState?.playerStreak ?? playerStreak,
    rivalStreak: mp.state.serverState?.rivalStreak ?? rivalStreak,
    timeLeft, playerPrediction: localPrediction,
    lockedCall: storedPrediction,
    roundResult, roundHistory,
    hitEffect, shakeScreen, showStreak,
    playerCharState, rivalCharState,
    matchId: mp.state.serverState?.matchId ?? null,
    isBotMatch,
    // Ghost-funding gate flag (bot matches only): true while the one-time
    // deposit is pending/not-landed during a fight phase; false once funded.
    // PvP has no ghost and is never held.
    funded: mp.state.serverState?.funded === true,
    fundingHeld: isBotMatch &&
      mp.state.serverState?.funded !== true &&
      (phase === "MATCH_INTRO" || phase === "ROUND_START" || phase === "ROUND_ACTIVE" || phase === "ROUND_LOCKED"),
    connectionStatus: connectionDisplay,
    pingMs: mp.state.pingMs,
    predictionStatus: mp.state.predictionStatus === "idle" ? predictionUIStatus : mp.state.predictionStatus,
    lastError: mp.state.lastError,
    connectionMessage,
    isReconnecting: !isBotMatch && mp.state.connectionStatus === "reconnecting",
    selectedPrediction,
    botDifficulty,
    selectedAmount,
    executionStatus,
    executionError,
    lastTxHash,
    playerHP: mp.state.serverState?.playerHP ?? playerHP,
    rivalHP: mp.state.serverState?.rivalHP ?? rivalHP,
    maxHP: MAX_HP,
    combatPhase, lastDamage, isFinalRound, koOverlay,
    market: mp.state.serverState?.market,
    playerBalance: mp.state.serverState?.playerBalance ?? 100,
    rivalBalance: mp.state.serverState?.rivalBalance ?? 100,
    playerStartBalance: mp.state.serverState?.playerStartBalance ?? 100,
    rivalStartBalance: mp.state.serverState?.rivalStartBalance ?? 100,
    playerAmountPerRound: mp.state.serverState?.playerAmountPerRound ?? 1,
    rivalAmountPerRound: mp.state.serverState?.rivalAmountPerRound ?? 1,
    selectedMatchId,
    positionWindowId,
    positionDirection,
    positionAmount,
    positionMarket,
    positionStakeTxHash,
    positionEscrowAddress,
    positionEntryPrice,
    positionSettlementOutcome,
    positionWonPositions,
    reloadPosition,
    hasActivePosition: Boolean(positionWindowId && positionDirection),
    actions: {
      goToHome, goToMarketSelect, goToCharSelect, goToLeaderboard,
      goToProfile, goToMatchHistory, goToStakeHistory, goToMatchDetail,
      selectMarket, selectChar, confirmDuel, selectPrediction, setMatchPrediction, selectDifficulty, selectAmount, makePrediction, rematch,
      joinMatchmaking, startPvPMatch, setReady, startDuel, cancelMatchmaking, fightBotInstead,
      goToPosition, goToMatchType, openPosition, changePosition,
    },
  };
}
