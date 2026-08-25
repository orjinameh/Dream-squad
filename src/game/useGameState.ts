"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { type CharacterDef, CHARACTERS, RIVAL_NAMES } from "./characters";
import { type GamePhase, type GameMode, type Prediction, type RoundResult, GAME_MODES } from "./types";
import {
  useMultiplayer,
  type UseMultiplayerReturn,
  type ServerMatchState,
  type ConnectionStatus,
} from "./useMultiplayer";

const LOCK_DURATION = 1200;
const REVEAL_DURATION = 1500;
const IMPACT_DURATION = 1400;
const MATCH_INTRO_DURATION = 2000;
const ROUND_TRANSITION_DELAY = 800;

export interface GameActions {
  goToHome: () => void;
  goToModeSelect: () => void;
  goToCharSelect: () => void;
  goToLeaderboard: () => void;
  selectMode: (mode: GameMode) => void;
  selectChar: (char: CharacterDef) => void;
  confirmDuel: () => void;
  makePrediction: (pred: "UP" | "DOWN") => void;
  rematch: () => void;
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
  playerCharState: "idle" | "thinking" | "locked" | "attack" | "hit" | "victory" | "defeat";
  rivalCharState: "idle" | "thinking" | "locked" | "attack" | "hit" | "victory" | "defeat";
  matchId: string | null;
  connectionStatus: ConnectionStatus;
  pingMs: number;
  predictionStatus: "idle" | "selected" | "submitting" | "confirmed" | "error";
  lastError: string | null;
  connectionMessage: string | null;
  isReconnecting: boolean;
  actions: GameActions;
}

export function useGameState(): GameHook {
  const mp = useMultiplayer();

  const [phase, setPhase] = useState<GamePhase>("HOME");
  const [mode, setMode] = useState<GameMode | null>(null);
  const [playerChar, setPlayerChar] = useState<CharacterDef | null>(null);
  const [rivalChar, setRivalChar] = useState<CharacterDef | null>(null);
  const [rivalName, setRivalName] = useState("");
  const [playerStreak, setPlayerStreak] = useState(0);
  const [rivalStreak, setRivalStreak] = useState(0);
  const [timeLeft, setTimeLeft] = useState(10);
  const [playerPrediction, setPlayerPrediction] = useState<Prediction>(null);
  const [localPrediction, setLocalPrediction] = useState<Prediction>(null);
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null);
  const [roundHistory, setRoundHistory] = useState<RoundResult[]>([]);
  const [hitEffect, setHitEffect] = useState<"none" | "player-hit" | "rival-hit" | "both-hit">("none");
  const [shakeScreen, setShakeScreen] = useState(false);
  const [showStreak, setShowStreak] = useState<string | null>(null);
  const [playerCharState, setPlayerCharState] = useState<"idle" | "thinking" | "locked" | "attack" | "hit" | "victory" | "defeat">("idle");
  const [rivalCharState, setRivalCharState] = useState<"idle" | "thinking" | "locked" | "attack" | "hit" | "victory" | "defeat">("idle");
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [reconnectMatchId, setReconnectMatchId] = useState<string | null>(null);

  const animFrameRef = useRef<number>(0);
  const phaseTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const prevRoundRef = useRef(0);
  const roundProcessedRef = useRef<number[]>([]);
  const enteredFromIntroRef = useRef(false);

  const clearAllTimers = useCallback(() => {
    phaseTimersRef.current.forEach(clearTimeout);
    phaseTimersRef.current = [];
  }, []);

  useEffect(() => () => { clearAllTimers(); cancelAnimationFrame(animFrameRef.current); }, [clearAllTimers]);

  // Smooth countdown: runs every frame, driven by server clock
  useEffect(() => {
    if (phase !== "ROUND_ACTIVE") return;

    let running = true;
    const tick = () => {
      if (!running) return;
      const remaining = mp.actions.getTimeRemaining();
      setTimeLeft(+remaining.toFixed(2));
      animFrameRef.current = requestAnimationFrame(tick);
    };
    tick();

    return () => { running = false; cancelAnimationFrame(animFrameRef.current); };
  }, [phase, mp.actions.getTimeRemaining]);

  const scheduleTimer = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    phaseTimersRef.current.push(t);
    return t;
  }, []);

  // Respond to server state changes — drive visual phases
  useEffect(() => {
    const ss = mp.state.serverState;
    if (!ss || ss.status !== "ACTIVE") return;

    const roundNum = ss.currentRound;

    if (ss.roundPhase === "ACTIVE" && phase !== "ROUND_ACTIVE" && phase !== "MATCH_INTRO") {
      setLocalPrediction(null);
      setPlayerPrediction(null);
      setRoundResult(null);
      setPlayerCharState("thinking");
      setRivalCharState("thinking");
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

        const result: RoundResult = {
          roundNum: lastRound.roundNum,
          actual: lastRound.actual,
          playerPredicted: lastRound.playerPrediction,
          rivalPredicted: lastRound.rivalPrediction,
          playerCorrect: lastRound.playerCorrect,
          rivalCorrect: lastRound.rivalCorrect,
        };
        setRoundResult(result);
        setRoundHistory((prev) => [...prev, result]);

        if (lastRound.playerCorrect) {
          setPlayerScore((s) => s + 1);
          setPlayerStreak((s) => {
            const ns = s + 1;
            if (ns >= 4) setShowStreak("UNSTOPPABLE");
            else if (ns === 3) setShowStreak("ON_FIRE");
            else if (ns === 2) setShowStreak("COMBO");
            else setShowStreak("STRIKE");
            return ns;
          });
          setPlayerCharState("attack");
          setRivalCharState("hit");
          setHitEffect("rival-hit");
        } else {
          setPlayerStreak(0);
          setPlayerCharState("hit");
          setRivalCharState("attack");
          setHitEffect("player-hit");
        }

        if (lastRound.rivalCorrect) {
          setRivalScore((s) => s + 1);
          setRivalStreak((s) => s + 1);
        } else {
          setRivalStreak(0);
        }

        setShakeScreen(true);
        scheduleTimer(() => setShakeScreen(false), 400);

        setPhase("ROUND_LOCKED");
        scheduleTimer(() => setPhase("ROUND_REVEAL"), LOCK_DURATION);
        scheduleTimer(() => {
          setPhase("ROUND_IMPACT");
          setHitEffect("none");
        }, LOCK_DURATION + REVEAL_DURATION);
        scheduleTimer(() => {
          if (lastRound.roundNum >= ss.totalRounds) {
            setPhase("MATCH_RESULT");
            setPlayerCharState("victory");
            setRivalCharState("defeat");
          } else {
            setPlayerCharState("idle");
            setRivalCharState("idle");
            setPhase("ROUND_START");
            scheduleTimer(() => {
              setPlayerCharState("thinking");
              setRivalCharState("thinking");
              setPhase("ROUND_ACTIVE");
            }, ROUND_TRANSITION_DELAY);
          }
        }, LOCK_DURATION + REVEAL_DURATION + IMPACT_DURATION);
      }
    }
  }, [mp.state.serverState, phase, scheduleTimer]);

  const [playerScore, setPlayerScore] = useState(0);
  const [rivalScore, setRivalScore] = useState(0);

  const startMatch = useCallback(async (walletAddress?: string) => {
    setPhase("MATCH_INTRO");
    enteredFromIntroRef.current = true;
    roundProcessedRef.current = [];

    const rc = CHARACTERS.filter((c) => c.id !== playerChar?.id);
    const rival = rc[Math.floor(Math.random() * rc.length)];
    const rn = RIVAL_NAMES[Math.floor(Math.random() * RIVAL_NAMES.length)];
    setRivalChar(rival);
    setRivalName(rn);

    setPlayerScore(0);
    setRivalScore(0);
    setPlayerStreak(0);
    setRivalStreak(0);
    setRoundHistory([]);
    setRoundResult(null);
    setPlayerPrediction(null);
    setLocalPrediction(null);
    setHitEffect("none");
    setShakeScreen(false);
    setShowStreak(null);
    setPlayerCharState("idle");
    setRivalCharState("idle");

    try {
      await mp.actions.createMatch({
        playerAddress: walletAddress || "0x0000000000000000000000000000000000000000",
        playerChar: playerChar?.id ?? "dreamer",
        rivalName: rn,
        rivalChar: rival.id,
        mode: mode?.id ?? "battle",
        totalRounds: mode?.rounds ?? 7,
      });
    } catch {
      // Continue anyway — game works offline with AI
    }

    scheduleTimer(() => {
      setPhase("ROUND_START");
      scheduleTimer(() => {
        setPhase("ROUND_ACTIVE");
        setPlayerCharState("thinking");
        setRivalCharState("thinking");
      }, ROUND_TRANSITION_DELAY);
    }, MATCH_INTRO_DURATION);
  }, [playerChar, mode, mp.actions, scheduleTimer]);

  const makePrediction = useCallback(async (pred: "UP" | "DOWN") => {
    if (phase !== "ROUND_ACTIVE" || localPrediction !== null) return;

    // Optimistic UI: instant feedback
    setLocalPrediction(pred);
    setPlayerPrediction(pred);
    setPredictionUIStatus("selected");
    setPlayerCharState("locked");

    // Submit to server
    setPredictionUIStatus("submitting");
    const result = await mp.actions.submitPrediction(pred);

    if (result) {
      setPredictionUIStatus("confirmed");
    } else {
      // Optimistic fallback: treat as locally locked even if network fails
      setPredictionUIStatus("confirmed");
    }
  }, [phase, localPrediction, mp.actions]);

  const [predictionUIStatus, setPredictionUIStatus] = useState<"idle" | "selected" | "submitting" | "confirmed">("idle");

  useEffect(() => {
    if (phase === "ROUND_ACTIVE") {
      setPredictionUIStatus("idle");
    }
  }, [phase, mp.state.serverState?.roundPhase]);

  // Connection status messages
  useEffect(() => {
    const cs = mp.state.connectionStatus;
    if (cs === "reconnecting") {
      setConnectionMessage("CONNECTION LOST\nRECONNECTING...");
    } else if (cs === "high") {
      setConnectionMessage(null);
    } else if (phase !== "HOME") {
      setConnectionMessage(null);
    }
  }, [mp.state.connectionStatus, phase]);

  const rematch = useCallback(() => {
    clearAllTimers();
    mp.actions.reset();
    roundProcessedRef.current = [];
    setPhase("CHAR_SELECT");
    setPlayerPrediction(null);
    setLocalPrediction(null);
    setRoundResult(null);
    setRoundHistory([]);
    setPlayerScore(0);
    setRivalScore(0);
    setPlayerStreak(0);
    setRivalStreak(0);
    setHitEffect("none");
    setShakeScreen(false);
    setShowStreak(null);
    setPlayerCharState("idle");
    setRivalCharState("idle");
    setPredictionUIStatus("idle");
  }, [clearAllTimers, mp.actions]);

  const goToHome = useCallback(() => { clearAllTimers(); mp.actions.reset(); setPhase("HOME"); roundProcessedRef.current = []; }, [clearAllTimers, mp.actions]);
  const goToModeSelect = useCallback(() => { setPhase("MODE_SELECT"); }, []);
  const goToCharSelect = useCallback(() => { clearAllTimers(); mp.actions.reset(); setPhase("CHAR_SELECT"); roundProcessedRef.current = []; }, [clearAllTimers, mp.actions]);
  const goToLeaderboard = useCallback(() => { setPhase("HOME"); }, []);

  const selectMode = useCallback((m: GameMode) => {
    setMode(m);
    setPhase("CHAR_SELECT");
  }, []);

  const selectChar = useCallback((c: CharacterDef) => {
    setPlayerChar(c);
    setPhase("DUEL_CONFIRM");
  }, []);

  const confirmDuel = useCallback(() => {
    startMatch();
  }, [startMatch]);

  // Derived connection info
  const isReconnecting = mp.state.connectionStatus === "reconnecting";
  const connectionDisplay: ConnectionStatus = mp.state.connectionStatus;

  return {
    phase, mode, playerChar, rivalChar, rivalName,
    currentRound: mp.state.serverState?.currentRound ?? 1,
    totalRounds: mp.state.serverState?.totalRounds ?? mode?.rounds ?? 7,
    playerScore: mp.state.serverState?.playerScore ?? playerScore,
    rivalScore: mp.state.serverState?.rivalScore ?? rivalScore,
    playerStreak, rivalStreak,
    timeLeft, playerPrediction: localPrediction,
    roundResult, roundHistory,
    hitEffect, shakeScreen, showStreak,
    playerCharState, rivalCharState,
    matchId: mp.state.serverState?.matchId ?? null,
    connectionStatus: connectionDisplay,
    pingMs: mp.state.pingMs,
    predictionStatus: mp.state.predictionStatus,
    lastError: mp.state.lastError,
    connectionMessage,
    isReconnecting,
    actions: {
      goToHome, goToModeSelect, goToCharSelect, goToLeaderboard,
      selectMode, selectChar, confirmDuel, makePrediction, rematch,
    },
  };
}
