"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { type CharacterDef, CHARACTERS, RIVAL_NAMES } from "./characters";
import { type GamePhase, type GameMode, type Prediction, type RoundResult, type PredictionConfig, type BotDifficulty, type FighterState, type CombatPhase, GAME_MODES, PREDICTIONS } from "./types";
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
const ROUND_TIME = 10;

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
  goToModeSelect: () => void;
  goToCharSelect: () => void;
  goToLeaderboard: () => void;
  goToProfile: () => void;
  goToMatchHistory: () => void;
  goToMatchDetail: (matchId: string) => void;
  selectMode: (mode: GameMode) => void;
  selectChar: (char: CharacterDef) => void;
  confirmDuel: () => void;
  selectPrediction: (pred: PredictionConfig) => void;
  selectDifficulty: (diff: BotDifficulty) => void;
  makePrediction: (pred: "UP" | "DOWN") => void;
  rematch: () => void;
  joinMatchmaking: (rounds: number) => void;
  startPvPMatch: (matchId: string) => void;
  setReady: () => void;
  cancelMatchmaking: () => void;
  fightBotInstead: () => void;
}

export interface GameHook {
  phase: GamePhase;
  mode: GameMode | null;
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
  roundResult: RoundResult | null;
  roundHistory: RoundResult[];
  hitEffect: "none" | "player-hit" | "rival-hit" | "both-hit";
  shakeScreen: boolean;
  showStreak: string | null;
  playerCharState: FighterState;
  rivalCharState: FighterState;
  matchId: string | null;
  isBotMatch: boolean;
  connectionStatus: ConnectionStatus;
  pingMs: number;
  predictionStatus: "idle" | "selected" | "submitting" | "confirmed" | "error";
  lastError: string | null;
  connectionMessage: string | null;
  isReconnecting: boolean;
  selectedPrediction: PredictionConfig;
  botDifficulty: BotDifficulty;
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
  actions: GameActions;
}

export function useGameState(): GameHook {
  const mp = useMultiplayer();
  const { address } = useAccount();

  // Sync wallet address into multiplayer for PvP predict submissions
  useEffect(() => {
    if (address) mp.actions.setAddress(address);
  }, [address, mp.actions]);

  const [phase, setPhase] = useState<GamePhase>("HOME");
  const [mode, setMode] = useState<GameMode | null>(null);
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

  const animFrameRef = useRef<number>(0);
  const phaseTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const roundProcessedRef = useRef<number[]>([]);
  const botTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const enteredFromIntroRef = useRef(false);
  const modeRef = useRef<GameMode | null>(null);
  const localPredictionRef = useRef<Prediction>(null);
  const phaseRef = useRef<GamePhase>("HOME");
  const playerHPRef = useRef(MAX_HP);
  const rivalHPRef = useRef(MAX_HP);

  // Round lifecycle guards
  const roundIdentityRef = useRef<string | null>(null);
  const roundPhaseRef = useRef<"LOCKED" | "SUBMITTING" | "WAITING_SERVER" | "ANIMATING" | "RESOLVED">("LOCKED");
  const activeRoundNumRef = useRef<number>(0);
  const lastServerPhaseKeyRef = useRef<string | null>(null);

  // Keep refs in sync for use inside intervals/timeouts
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { localPredictionRef.current = localPrediction; }, [localPrediction]);

  const clearAllTimers = useCallback(() => {
    phaseTimersRef.current.forEach(clearTimeout);
    phaseTimersRef.current = [];
    if (botTimerRef.current) { clearInterval(botTimerRef.current); botTimerRef.current = null; }
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
    setRoundHistory((prev) => [...prev, result]);

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
        setLocalPrediction(null); setPlayerPrediction(null);
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

  // --- BOT COUNTDOWN TIMER ---
  // Visual countdown only. Server resolves the round via predict endpoint.
  useEffect(() => {
    if (!isBotMatch || phase !== "ROUND_ACTIVE") return;
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

        // If no prediction, auto-pick for submission
        if (!localPredictionRef.current) {
          const auto: "UP" | "DOWN" = Math.random() < 0.5 ? "UP" : "DOWN";
          setLocalPrediction(auto);
          setPlayerPrediction(auto);
        }

        // Submit to server — server resolves everything
        const pred = localPredictionRef.current as "UP" | "DOWN";
        setExecutionStatus("executing");
        roundPhaseRef.current = "SUBMITTING";

        mp.actions.submitPrediction(pred).then(() => {
          setExecutionStatus("success");
          roundPhaseRef.current = "WAITING_SERVER";
        }).catch(() => {
          // Server may still process — poll will pick up result
          setExecutionStatus("success");
          roundPhaseRef.current = "WAITING_SERVER";
        });
      }
    };

    botTimerRef.current = setInterval(tick, 50) as unknown as ReturnType<typeof setInterval>;
    return () => {
      if (botTimerRef.current) { clearInterval(botTimerRef.current); botTimerRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBotMatch, phase]);

  // --- SERVER-SYNCED MULTIPLAYER ---
  // Responds to server state changes for both bot and PvP matches
  useEffect(() => {
    const ss = mp.state.serverState;
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

    // Track server phase transitions
    const phaseKey = `${ss.currentRound}-${ss.roundPhase}`;
    if (phaseKey === lastServerPhaseKeyRef.current) return;
    lastServerPhaseKeyRef.current = phaseKey;

    const lastRound = ss.rounds?.[ss.rounds.length - 1];
    const hasNewResolvedRound = !!lastRound && !roundProcessedRef.current.includes(lastRound.roundNum);

    // A newly-resolved round has appeared (ANY roundPhase — intermediate rounds
    // report the next round as ACTIVE). Play the authoritative combat animation
    // and let proceedToReveal advance the match. Handles every round, not just
    // the final one.
    if (hasNewResolvedRound) {
      roundProcessedRef.current.push(lastRound.roundNum);
      playCombatAnimation(lastRound, ss.totalRounds, ss.playerHP, ss.rivalHP, ss.playerScore, ss.rivalScore);
      return;
    }

    // Otherwise, when the server says the (next) round is ACTIVE, open it from a
    // clean slate (match intro or first round).
    if (ss.roundPhase === "ACTIVE") {
      roundIdentityRef.current = `${isBotMatch ? "bot" : "pvp"}-${ss.currentRound}`;
      activeRoundNumRef.current = ss.currentRound;
      roundPhaseRef.current = "LOCKED";
      setLocalPrediction(null);
      setPlayerPrediction(null);
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

    setPlayerScore(0); setRivalScore(0);
    setPlayerStreak(0); setRivalStreak(0);
    setRoundHistory([]); setRoundResult(null);
    setPlayerPrediction(null); setLocalPrediction(null);
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

    // Create server-side match — store matchId for bot matches too
    try {
      const res = await mp.actions.createMatch({
        playerAddress: address || "0x0000000000000000000000000000000000000000",
        playerChar: playerChar?.id ?? "dreamer",
        rivalName: rn,
        rivalChar: rival.id,
        mode: mode?.id ?? "battle",
        totalRounds: mode?.rounds ?? 7,
        predictionAsset: selectedPrediction?.asset,
      });
      if (res?.matchId) {
        // Store matchId — bot matches MUST have real matchIds
        mp.actions.reconnectToMatch(res.matchId);
      }
    } catch {
      // Continue even if server create fails
    }

    scheduleTimer(() => {
      setPhase("ROUND_START");
      scheduleTimer(() => {
        setPhase("ROUND_ACTIVE");
        setPlayerCharState("thinking");
        setRivalCharState("thinking");
      }, ROUND_TRANSITION_DELAY);
    }, MATCH_INTRO_DURATION);
  }, [playerChar, mode, scheduleTimer, address, mp.actions]);

  // --- PREDICTION ---
  const makePrediction = useCallback(async (pred: "UP" | "DOWN") => {
    if (phase !== "ROUND_ACTIVE") return;

    // Optimistic UI: always allows changing
    setLocalPrediction(pred);
    setPlayerPrediction(pred);
    setPredictionUIStatus("selected");

    // Submit to server — server resolves everything
    setPredictionUIStatus("submitting");
    setExecutionStatus("executing");
    setExecutionError(null);
    roundPhaseRef.current = "SUBMITTING";

    const result = await mp.actions.submitPrediction(pred);
    setPredictionUIStatus(result ? "confirmed" : "confirmed");
    setExecutionStatus("success");
    roundPhaseRef.current = "WAITING_SERVER";
  }, [phase, mp.actions]);

  const rematch = useCallback(() => {
    clearAllTimers();
    mp.actions.reset();
    roundProcessedRef.current = [];
    roundIdentityRef.current = null;
    roundPhaseRef.current = "LOCKED";
    activeRoundNumRef.current = 0;
    lastServerPhaseKeyRef.current = null;
    setPhase("CHAR_SELECT");
    setPlayerPrediction(null); setLocalPrediction(null);
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
  const goToModeSelect = useCallback(() => { setPhase("MODE_SELECT"); }, []);
  const goToCharSelect = useCallback(() => { clearAllTimers(); mp.actions.reset(); setPhase("CHAR_SELECT"); roundProcessedRef.current = []; lastServerPhaseKeyRef.current = null; }, [clearAllTimers, mp.actions]);
  const goToLeaderboard = useCallback(() => { window.location.href = "/leaderboard"; }, []);
  const goToProfile = useCallback(() => { setPhase("PROFILE"); }, []);
  const goToMatchHistory = useCallback(() => { setPhase("MATCH_HISTORY"); }, []);
  const goToMatchDetail = useCallback((matchId: string) => { setSelectedMatchId(matchId); setPhase("MATCH_DETAIL"); }, []);
  const selectMode = useCallback((m: GameMode) => { setMode(m); setPhase("CHAR_SELECT"); }, []);
  const selectChar = useCallback((c: CharacterDef) => { setPlayerChar(c); setPhase("DUEL_CONFIRM"); }, []);
  const confirmDuel = useCallback(() => { setPhase("PREDICTION_SELECT"); }, []);
  const selectPrediction = useCallback((pred: PredictionConfig) => { setSelectedPrediction(pred); startMatch(); }, [startMatch]);
  const selectDifficulty = useCallback((diff: BotDifficulty) => { setBotDifficulty(diff); }, []);

  const joinMatchmaking = useCallback((selectedRounds: number) => {
    clearAllTimers();
    roundProcessedRef.current = [];
    lastServerPhaseKeyRef.current = null;
    setIsBotMatch(false);
    setMode(GAME_MODES.find((m) => m.rounds === selectedRounds) ?? GAME_MODES[2]);
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
    setPhase("CHAR_SELECT");
    setIsBotMatch(true);
  }, [clearAllTimers, mp.actions]);

  const connectionDisplay: ConnectionStatus = isBotMatch ? "local" : mp.state.connectionStatus;

  return {
    phase, mode, playerChar, rivalChar, rivalName,
    currentRound: displayRound,
    totalRounds: isBotMatch ? (mode?.rounds ?? 7) : (mp.state.serverState?.totalRounds ?? mode?.rounds ?? 7),
    playerScore: mp.state.serverState?.playerScore ?? playerScore,
    rivalScore: mp.state.serverState?.rivalScore ?? rivalScore,
    playerStreak: mp.state.serverState?.playerStreak ?? playerStreak,
    rivalStreak: mp.state.serverState?.rivalStreak ?? rivalStreak,
    timeLeft, playerPrediction: localPrediction,
    roundResult, roundHistory,
    hitEffect, shakeScreen, showStreak,
    playerCharState, rivalCharState,
    matchId: mp.state.serverState?.matchId ?? null,
    isBotMatch,
    connectionStatus: connectionDisplay,
    pingMs: mp.state.pingMs,
    predictionStatus: mp.state.predictionStatus === "idle" ? predictionUIStatus : mp.state.predictionStatus,
    lastError: mp.state.lastError,
    connectionMessage,
    isReconnecting: !isBotMatch && mp.state.connectionStatus === "reconnecting",
    selectedPrediction,
    botDifficulty,
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
    selectedMatchId,
    actions: {
      goToHome, goToModeSelect, goToCharSelect, goToLeaderboard,
      goToProfile, goToMatchHistory, goToMatchDetail,
      selectMode, selectChar, confirmDuel, selectPrediction, selectDifficulty, makePrediction, rematch,
      joinMatchmaking, startPvPMatch, setReady, cancelMatchmaking, fightBotInstead,
    },
  };
}
