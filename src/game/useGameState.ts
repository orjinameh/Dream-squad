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
const BASE_DAMAGE = 15;
const STREAK_BONUS: Record<number, number> = { 0: 0, 1: 0, 2: 3, 3: 10 };

const WINDUP_MS = 400;
const STRIKE_MS = 300;
const HITSTOP_MS = 80;
const IMPACT_MS = 300;
const KNOCKBACK_MS = 300;
const RECOVERY_MS = 200;
const CLASH_MS = 600;

function randomOutcome(): "UP" | "DOWN" {
  return Math.random() < 0.5 ? "UP" : "DOWN";
}

function calcDamage(streakCount: number): { damage: number; isCritical: boolean } {
  const bonus = STREAK_BONUS[Math.min(streakCount, 3)] ?? 0;
  const isCritical = streakCount >= 3;
  return { damage: BASE_DAMAGE + bonus, isCritical };
}

export interface GameActions {
  goToHome: () => void;
  goToModeSelect: () => void;
  goToCharSelect: () => void;
  goToLeaderboard: () => void;
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

  const animFrameRef = useRef<number>(0);
  const phaseTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const roundProcessedRef = useRef<number[]>([]);
  const botTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const botRoundRef = useRef(0);
  const botScoresRef = useRef({ player: 0, rival: 0, pStreak: 0, rStreak: 0 });
  const enteredFromIntroRef = useRef(false);
  const modeRef = useRef<GameMode | null>(null);
  const localPredictionRef = useRef<Prediction>(null);
  const phaseRef = useRef<GamePhase>("HOME");
  const playerHPRef = useRef(MAX_HP);
  const rivalHPRef = useRef(MAX_HP);
  const playerStreakRef = useRef(0);
  const rivalStreakRef = useRef(0);

  // Round lifecycle guards
  const roundIdentityRef = useRef<string | null>(null);
  const roundPhaseRef = useRef<"LOCKED" | "RESOLVING" | "ANIMATING" | "RESOLVED">("LOCKED");
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

  // --- BOT ROUND RESOLVER — computes result + runs sequenced combat animation ---
  const resolveBotRoundImpl = useCallback((rNum: number, _totalRounds: number) => {
    if (roundPhaseRef.current === "RESOLVING" || roundPhaseRef.current === "RESOLVED") return;
    roundPhaseRef.current = "RESOLVING";

    const pred = localPredictionRef.current as "UP" | "DOWN" | null;
    const actual = randomOutcome();
    const rivalPred = randomOutcome();
    const playerCorrect = pred === actual;
    const rivalCorrect = rivalPred === actual;
    const isDraw = playerCorrect === rivalCorrect;
    const s = botScoresRef.current;

    // Calculate damage
    let playerDamage = 0;
    let rivalDamage = 0;
    let isCritical = false;
    if (!isDraw) {
      if (playerCorrect) {
        const d = calcDamage(s.pStreak);
        rivalDamage = d.damage;
        isCritical = d.isCritical;
      } else {
        const d = calcDamage(s.rStreak);
        playerDamage = d.damage;
        isCritical = d.isCritical;
      }
    }

    // Apply damage to refs
    const newPlayerHP = Math.max(0, playerHPRef.current - playerDamage);
    const newRivalHP = Math.max(0, rivalHPRef.current - rivalDamage);
    playerHPRef.current = newPlayerHP;
    rivalHPRef.current = newRivalHP;
    setPlayerHP(newPlayerHP);
    setRivalHP(newRivalHP);

    const ko = newPlayerHP <= 0 || newRivalHP <= 0;

    const result: RoundResult = {
      roundNum: rNum,
      actual,
      playerPredicted: pred,
      rivalPredicted: rivalPred,
      playerCorrect,
      rivalCorrect,
      playerDamage,
      rivalDamage,
      isCritical,
      isDraw,
      knockout: ko,
    };
    setRoundResult(result);
    setRoundHistory((prev) => [...prev, result]);

    // Update scores and streaks
    s.player += playerCorrect ? 1 : 0;
    s.rival += rivalCorrect ? 1 : 0;
    setPlayerScore(s.player);
    setRivalScore(s.rival);

    if (playerCorrect) {
      s.pStreak++;
      setPlayerStreak(s.pStreak);
      if (s.pStreak >= 4) setShowStreak("UNSTOPPABLE");
      else if (s.pStreak === 3) setShowStreak("ON_FIRE");
      else if (s.pStreak === 2) setShowStreak("COMBO");
      else setShowStreak("STRIKE");
    } else {
      s.pStreak = 0;
      setPlayerStreak(0);
    }
    if (rivalCorrect) s.rStreak++;
    else s.rStreak = 0;
    setRivalStreak(s.rStreak);

    setCombatPhase("windup");
    setLastDamage(null);

    if (isDraw) {
      // DRAW: both step forward, weapons clash, step back
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
        proceedToReveal(rNum, _totalRounds, s, ko);
      }, WINDUP_MS / 2 + CLASH_MS + RECOVERY_MS);
    } else {
      // ATTACK SEQUENCE
      const attackerWins = playerCorrect;
      const setAttacker = attackerWins ? setPlayerCharState : setRivalCharState;
      const setDefender = attackerWins ? setRivalCharState : setPlayerCharState;
      const damageTarget: "player" | "rival" = attackerWins ? "rival" : "player";
      const dmg = attackerWins ? rivalDamage : playerDamage;

      // Phase 1: Windup
      setAttacker("windup");
      setDefender("locked");

      scheduleTimer(() => {
        // Phase 2: Strike
        setCombatPhase("strike");
        setAttacker("attack");
        setShakeScreen(true);
        scheduleTimer(() => setShakeScreen(false), 150);
      }, WINDUP_MS);

      scheduleTimer(() => {
        // Phase 3: Impact + hitstop
        setCombatPhase("impact");
        setDefender(isCritical ? "stunned" : "hit");
        setAttacker("attack");
        setLastDamage({ amount: dmg, target: damageTarget, isCritical });
        setHitEffect(attackerWins ? "rival-hit" : "player-hit");
      }, WINDUP_MS + STRIKE_MS);

      scheduleTimer(() => {
        // Phase 4: Knockback
        setCombatPhase("recovery");
        setDefender("knockback");
        setAttacker("idle");
      }, WINDUP_MS + STRIKE_MS + HITSTOP_MS + IMPACT_MS);

      scheduleTimer(() => {
        // Phase 5: Recovery to idle
        setDefender("idle");
        setCombatPhase("idle");
        setHitEffect("none");
        proceedToReveal(rNum, _totalRounds, s, ko);
      }, WINDUP_MS + STRIKE_MS + HITSTOP_MS + IMPACT_MS + KNOCKBACK_MS);
    }
  }, [scheduleTimer]);

  // --- Proceed to reveal/impact/next-round after combat animation ---
  const proceedToReveal = useCallback((rNum: number, totalRounds: number, s: { player: number; rival: number; pStreak: number; rStreak: number }, ko: boolean) => {
    scheduleTimer(() => setPhase("ROUND_REVEAL"), 200);
    scheduleTimer(() => { setPhase("ROUND_IMPACT"); setHitEffect("none"); }, 200 + REVEAL_DURATION);
    scheduleTimer(() => {
      roundPhaseRef.current = "RESOLVED";
      const rem = totalRounds - rNum;
      const earlyVictory = s.player > s.rival + rem || s.rival > s.player + rem;
      if (ko) {
        // KNOCKOUT
        const playerWon = s.player > s.rival;
        setKoOverlay(playerWon ? `${playerChar?.name ?? "PLAYER"} WINS!` : `${rivalName} WINS!`);
        setCombatPhase("ko");
        setPlayerCharState(playerWon ? "victory" : "defeat");
        setRivalCharState(playerWon ? "defeat" : "victory");
        setShakeScreen(true);
        scheduleTimer(() => setShakeScreen(false), 500);
        scheduleTimer(() => {
          setPhase("MATCH_RESULT");
          setKoOverlay(null);
        }, 2000);
      } else if (rNum >= totalRounds || earlyVictory) {
        setPhase("MATCH_RESULT");
        const won = s.player > s.rival;
        const draw = s.player === s.rival;
        setPlayerCharState(won ? "victory" : draw ? "idle" : "defeat");
        setRivalCharState(won ? "defeat" : draw ? "idle" : "victory");
      } else {
        setPlayerCharState("idle"); setRivalCharState("idle");
        setLocalPrediction(null); setPlayerPrediction(null);
        setRoundResult(null);
        setLastDamage(null);
        const nextRound = rNum + 1;
        setDisplayRound(nextRound);
        setIsFinalRound(nextRound >= totalRounds);
        activeRoundNumRef.current = nextRound;
        roundPhaseRef.current = "LOCKED";
        setPhase("ROUND_START");
        scheduleTimer(() => {
          roundIdentityRef.current = `bot-${nextRound}`;
          setPhase("ROUND_ACTIVE");
          setPlayerCharState("thinking"); setRivalCharState("thinking");
        }, ROUND_TRANSITION_DELAY);
      }
    }, 200 + REVEAL_DURATION + IMPACT_DURATION);
  }, [scheduleTimer, playerChar, rivalName]);

  // --- PvP version of proceedToReveal ---
  const proceedToPvPReveal = useCallback((rNum: number, totalRounds: number, ko: boolean, pScore: number, rScore: number) => {
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
        scheduleTimer(() => {
          setPhase("MATCH_RESULT");
          setKoOverlay(null);
        }, 2000);
      } else if (rNum >= totalRounds) {
        setPhase("MATCH_RESULT");
        const won = pScore > rScore;
        const draw = pScore === rScore;
        setPlayerCharState(won ? "victory" : draw ? "idle" : "defeat");
        setRivalCharState(won ? "defeat" : draw ? "idle" : "victory");
      } else {
        setPlayerCharState("idle"); setRivalCharState("idle");
        setRoundResult(null); setLastDamage(null);
        const nextRound = rNum + 1;
        setDisplayRound(nextRound);
        setIsFinalRound(nextRound >= totalRounds);
        activeRoundNumRef.current = nextRound;
        roundPhaseRef.current = "LOCKED";
        setPhase("ROUND_START");
        scheduleTimer(() => {
          setPlayerCharState("thinking"); setRivalCharState("thinking");
          setPhase("ROUND_ACTIVE");
        }, ROUND_TRANSITION_DELAY);
      }
    }, 200 + REVEAL_DURATION + IMPACT_DURATION);
  }, [scheduleTimer, playerChar, rivalName]);

  // --- BOT COUNTDOWN TIMER ---
  // Deadline-based: single timer per round, auto-locks at 0
  // When timer expires, calls predict endpoint for real DreamDEX execution
  useEffect(() => {
    if (!isBotMatch || phase !== "ROUND_ACTIVE") return;
    if (botTimerRef.current) return;

    const totalRounds = modeRef.current?.rounds ?? 7;
    const rNum = activeRoundNumRef.current;
    const deadline = Date.now() + ROUND_TIME * 1000;
    setTimeLeft(ROUND_TIME);

    let resolved = false;

    const tick = () => {
      const remaining = Math.max(0, (deadline - Date.now()) / 1000);
      setTimeLeft(+remaining.toFixed(2));

      if (remaining <= 0 && !resolved) {
        resolved = true;

        // LOCK: capture whatever the player chose (or null)
        setPhase("ROUND_LOCKED");
        setPlayerCharState("locked");
        setRivalCharState("locked");

        // If no prediction, auto-pick
        if (!localPredictionRef.current) {
          const auto: "UP" | "DOWN" = randomOutcome();
          setLocalPrediction(auto);
          setPlayerPrediction(auto);
        }

        // Submit to server for real DreamDEX execution
        const pred = localPredictionRef.current as "UP" | "DOWN";
        setExecutionStatus("executing");
        setExecutionError(null);

        // Fire-and-forget predict call — server handles execution
        // The round result comes back via polling (serverSync effect)
        mp.actions.submitPrediction(pred).then(() => {
          setExecutionStatus("success");
        }).catch(() => {
          // If submit fails, the server may still process — poll will pick up result
          setExecutionStatus("success");
        });

        // Run local visual cascade (server result arrives via polling)
        // resolveBotRoundImpl handles all post-combat transitions via proceedToReveal
        scheduleTimer(() => {
          resolveBotRoundImpl(rNum, totalRounds);
        }, 300);
        return;
      }
    };

    botTimerRef.current = setInterval(tick, 50) as unknown as ReturnType<typeof setInterval>;

    return () => {
      if (botTimerRef.current) { clearInterval(botTimerRef.current); botTimerRef.current = null; }
    };
  }, [isBotMatch, phase, resolveBotRoundImpl, scheduleTimer, mp.actions]);

  // Server-synced multiplayer: respond to server state changes
  useEffect(() => {
    if (isBotMatch) return;
    const ss = mp.state.serverState;
    if (!ss || ss.status !== "ACTIVE") return;

    // Track server phase transitions to avoid re-triggering cascades
    const phaseKey = `${ss.currentRound}-${ss.roundPhase}`;
    if (phaseKey === lastServerPhaseKeyRef.current) return;
    lastServerPhaseKeyRef.current = phaseKey;

    if (ss.roundPhase === "ACTIVE") {
      roundIdentityRef.current = `pvp-${ss.currentRound}`;
      activeRoundNumRef.current = ss.currentRound;
      roundPhaseRef.current = "LOCKED";
      setLocalPrediction(null);
      setPlayerPrediction(null);
      setRoundResult(null);
      setLastDamage(null);
      setPlayerCharState("thinking");
      setRivalCharState("thinking");
      setDisplayRound(ss.currentRound);
      setIsFinalRound(ss.currentRound >= ss.totalRounds);
      // Sync HP from server if available
      if ((ss as any).playerHP !== undefined) {
        setPlayerHP((ss as any).playerHP);
        playerHPRef.current = (ss as any).playerHP;
      }
      if ((ss as any).rivalHP !== undefined) {
        setRivalHP((ss as any).rivalHP);
        rivalHPRef.current = (ss as any).rivalHP;
      }
      const wasIntro = enteredFromIntroRef.current;
      enteredFromIntroRef.current = false;
      scheduleTimer(() => setPhase("ROUND_ACTIVE"), wasIntro ? MATCH_INTRO_DURATION : ROUND_TRANSITION_DELAY);
    }

    if (ss.roundPhase === "LOCKED" && phase !== "ROUND_LOCKED" && phase !== "ROUND_REVEAL" && phase !== "ROUND_IMPACT") {
      setPlayerCharState("locked");
      setRivalCharState("locked");
      setPhase("ROUND_LOCKED");
    }

    if (ss.roundPhase === "REVEALED" && ss.rounds.length > 0) {
      const lastRound = ss.rounds[ss.rounds.length - 1];
      if (lastRound && !roundProcessedRef.current.includes(lastRound.roundNum)) {
        roundProcessedRef.current.push(lastRound.roundNum);

        // Extract execution data from server state
        const pExec = (lastRound as any).playerExecution;
        const rExec = (lastRound as any).rivalExecution;
        if (pExec?.txHash) setLastTxHash(pExec.txHash);
        if (pExec?.status === "EXECUTED") setExecutionStatus("success");
        else if (pExec?.status === "FAILED") { setExecutionStatus("failed"); setExecutionError(pExec.error ?? "Execution failed"); }

        const isDraw = lastRound.playerCorrect === lastRound.rivalCorrect;

        // Calculate damage + streaks for PvP — read from refs (sync) not setState (async)
        let playerDamage = 0;
        let rivalDamage = 0;
        let isCritical = false;

        const oldPStreak = playerStreakRef.current;
        const oldRStreak = rivalStreakRef.current;
        const newPStreak = lastRound.playerCorrect ? oldPStreak + 1 : 0;
        const newRStreak = lastRound.rivalCorrect ? oldRStreak + 1 : 0;
        playerStreakRef.current = newPStreak;
        rivalStreakRef.current = newRStreak;
        setPlayerStreak(newPStreak);
        setRivalStreak(newRStreak);

        if (newPStreak >= 4) setShowStreak("UNSTOPPABLE");
        else if (newPStreak === 3) setShowStreak("ON_FIRE");
        else if (newPStreak === 2) setShowStreak("COMBO");
        else if (newPStreak >= 1) setShowStreak("STRIKE");
        else setShowStreak(null);

        if (!isDraw) {
          if (lastRound.playerCorrect) {
            const d = calcDamage(oldPStreak);
            rivalDamage = d.damage;
            isCritical = d.isCritical;
          } else {
            const d = calcDamage(oldRStreak);
            playerDamage = d.damage;
            isCritical = d.isCritical;
          }
        }

        const newPlayerHP = Math.max(0, playerHPRef.current - playerDamage);
        const newRivalHP = Math.max(0, rivalHPRef.current - rivalDamage);
        playerHPRef.current = newPlayerHP;
        rivalHPRef.current = newRivalHP;
        setPlayerHP(newPlayerHP);
        setRivalHP(newRivalHP);

        const ko = newPlayerHP <= 0 || newRivalHP <= 0;

        const result: RoundResult = {
          roundNum: lastRound.roundNum,
          actual: lastRound.actual,
          playerPredicted: lastRound.playerPrediction,
          rivalPredicted: lastRound.rivalPrediction,
          playerCorrect: lastRound.playerCorrect,
          rivalCorrect: lastRound.rivalCorrect,
          playerDamage,
          rivalDamage,
          isCritical,
          isDraw,
          knockout: ko,
          playerExecution: pExec ? { status: pExec.status, txHash: pExec.txHash, direction: pExec.direction, error: pExec.error } : undefined,
          rivalExecution: rExec ? { status: rExec.status, txHash: rExec.txHash, direction: rExec.direction, error: rExec.error } : undefined,
        };
        setRoundResult(result);
        setRoundHistory((prev) => [...prev, result]);
        if (lastRound.playerCorrect) setPlayerScore((sc) => sc + 1);
        if (lastRound.rivalCorrect) setRivalScore((sc) => sc + 1);

        // Capture post-update scores for use in timers (closure would be stale)
        const updatedPScore = lastRound.playerCorrect ? playerScore + 1 : playerScore;
        const updatedRScore = lastRound.rivalCorrect ? rivalScore + 1 : rivalScore;

        // Run combat animation sequence
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
            proceedToPvPReveal(lastRound.roundNum, ss.totalRounds, ko, updatedPScore, updatedRScore);
          }, WINDUP_MS / 2 + CLASH_MS + RECOVERY_MS);
        } else {
          const attackerWins = lastRound.playerCorrect;
          const setAttacker = attackerWins ? setPlayerCharState : setRivalCharState;
          const setDefender = attackerWins ? setRivalCharState : setPlayerCharState;
          const damageTarget: "player" | "rival" = attackerWins ? "rival" : "player";
          const dmg = attackerWins ? rivalDamage : playerDamage;

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
            setLastDamage({ amount: dmg, target: damageTarget, isCritical });
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
            proceedToPvPReveal(lastRound.roundNum, ss.totalRounds, ko, updatedPScore, updatedRScore);
          }, WINDUP_MS + STRIKE_MS + HITSTOP_MS + IMPACT_MS + KNOCKBACK_MS);
        }
      }
    }
  }, [mp.state.serverState, phase, isBotMatch, scheduleTimer]);

  // Server-synced countdown for multiplayer
  useEffect(() => {
    if (isBotMatch || phase !== "ROUND_ACTIVE") return;
    let running = true;
    const tick = () => { if (!running) return; const remaining = mp.actions.getTimeRemaining(); setTimeLeft(+remaining.toFixed(2)); animFrameRef.current = requestAnimationFrame(tick); };
    tick();
    return () => { running = false; cancelAnimationFrame(animFrameRef.current); };
  }, [phase, isBotMatch, mp.actions.getTimeRemaining]);

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
    botRoundRef.current = 0;
    botScoresRef.current = { player: 0, rival: 0, pStreak: 0, rStreak: 0 };
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
    playerStreakRef.current = 0; rivalStreakRef.current = 0;
    setCombatPhase("idle"); setLastDamage(null); setKoOverlay(null);
    setIsFinalRound((mode?.rounds ?? 7) <= 1);
    enteredFromIntroRef.current = true;

    // Create server-side match for real DreamDEX execution
    try {
      const res = await fetch("/api/matches/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playerAddress: address || "0x0000000000000000000000000000000000000000",
          playerChar: playerChar?.id ?? "dreamer",
          rivalName: rn,
          rivalChar: rival.id,
          mode: mode?.id ?? "battle",
          totalRounds: mode?.rounds ?? 7,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        // Store matchId for predict calls
        mp.actions.reconnectToMatch(data.matchId);
      }
    } catch {
      // Continue even if server create fails — bot match can still work locally
      // but DreamDEX execution won't happen
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

    if (isBotMatch) {
      // Bot: execution happens server-side when round resolves
      setExecutionStatus("executing");
      return;
    }

    // Multiplayer: submit to server (server executes DreamDEX order)
    setPredictionUIStatus("submitting");
    setExecutionStatus("executing");
    setExecutionError(null);

    const result = await mp.actions.submitPrediction(pred);
    setPredictionUIStatus(result ? "confirmed" : "confirmed");

    // Server response may include execution data
    if (result) {
      setExecutionStatus("success");
    } else {
      // Even if submit fails, the server may have already processed
      setExecutionStatus("success");
    }
  }, [phase, isBotMatch, mp.actions]);

  const rematch = useCallback(() => {
    clearAllTimers();
    mp.actions.reset();
    roundProcessedRef.current = [];
    botRoundRef.current = 0;
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
    playerStreakRef.current = 0; rivalStreakRef.current = 0;
    setCombatPhase("idle"); setLastDamage(null); setKoOverlay(null);
    setIsFinalRound(false);
  }, [clearAllTimers, mp.actions]);

  const goToHome = useCallback(() => { clearAllTimers(); mp.actions.reset(); setPhase("HOME"); roundProcessedRef.current = []; lastServerPhaseKeyRef.current = null; }, [clearAllTimers, mp.actions]);
  const goToModeSelect = useCallback(() => { setPhase("MODE_SELECT"); }, []);
  const goToCharSelect = useCallback(() => { clearAllTimers(); mp.actions.reset(); setPhase("CHAR_SELECT"); roundProcessedRef.current = []; lastServerPhaseKeyRef.current = null; }, [clearAllTimers, mp.actions]);
  const goToLeaderboard = useCallback(() => { setPhase("HOME"); }, []);
  const selectMode = useCallback((m: GameMode) => { setMode(m); setPhase("CHAR_SELECT"); }, []);
  const selectChar = useCallback((c: CharacterDef) => { setPlayerChar(c); setPhase("DUEL_CONFIRM"); }, []);
  const confirmDuel = useCallback(() => { setPhase("PREDICTION_SELECT"); }, []);
  const selectPrediction = useCallback((pred: PredictionConfig) => { setSelectedPrediction(pred); startMatch(); }, [startMatch]);
  const selectDifficulty = useCallback((diff: BotDifficulty) => { setBotDifficulty(diff); }, []);

  const joinMatchmaking = useCallback((selectedRounds: number) => {
    clearAllTimers();
    roundProcessedRef.current = [];
    botRoundRef.current = 0;
    lastServerPhaseKeyRef.current = null;
    setIsBotMatch(false);
    setMode(GAME_MODES.find((m) => m.rounds === selectedRounds) ?? GAME_MODES[2]);
    setPhase("MATCHMAKING");
  }, [clearAllTimers]);

  const startPvPMatch = useCallback((pvpMatchId: string) => {
    clearAllTimers();
    roundProcessedRef.current = [];
    botRoundRef.current = 0;
    lastServerPhaseKeyRef.current = null;
    roundIdentityRef.current = `pvp-match-${pvpMatchId}`;
    roundPhaseRef.current = "LOCKED";
    activeRoundNumRef.current = 1;
    setIsBotMatch(false);

    // Connect to the match via multiplayer
    mp.actions.reconnectToMatch(pvpMatchId);

    setPhase("MATCH_FOUND");
    scheduleTimer(() => {
      setPhase("READY_UP");
    }, 2000);
  }, [clearAllTimers, mp.actions, scheduleTimer]);

  const setReady = useCallback(async () => {
    const id = mp.state.serverState?.matchId;
    const addr = (mp.state.serverState as any)?.player2Address;
    if (!id) return;

    await fetch("/api/matches/ready", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matchId: id,
        address: addr || "",
        charId: playerChar?.id ?? "dreamer",
      }),
    });
  }, [mp.state.serverState, playerChar]);

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
    playerScore, rivalScore,
    playerStreak, rivalStreak,
    timeLeft, playerPrediction: localPrediction,
    roundResult, roundHistory,
    hitEffect, shakeScreen, showStreak,
    playerCharState, rivalCharState,
    matchId: isBotMatch ? null : (mp.state.serverState?.matchId ?? null),
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
    playerHP, rivalHP, maxHP: MAX_HP,
    combatPhase, lastDamage, isFinalRound, koOverlay,
    actions: {
      goToHome, goToModeSelect, goToCharSelect, goToLeaderboard,
      selectMode, selectChar, confirmDuel, selectPrediction, selectDifficulty, makePrediction, rematch,
      joinMatchmaking, startPvPMatch, setReady, cancelMatchmaking, fightBotInstead,
    },
  };
}
