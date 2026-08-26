"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { type CharacterDef, CHARACTERS, RIVAL_NAMES } from "./characters";
import { type GamePhase, type GameMode, type Prediction, type RoundResult, GAME_MODES } from "./types";
import {
  useMultiplayer,
  type ConnectionStatus,
} from "./useMultiplayer";

const LOCK_DURATION = 1200;
const REVEAL_DURATION = 1500;
const IMPACT_DURATION = 1400;
const MATCH_INTRO_DURATION = 2000;
const ROUND_TRANSITION_DELAY = 800;
const ROUND_TIME = 10;

function randomOutcome(): "UP" | "DOWN" {
  return Math.random() < 0.5 ? "UP" : "DOWN";
}

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
  playerCharState: "idle" | "thinking" | "locked" | "attack" | "hit" | "victory" | "defeat";
  rivalCharState: "idle" | "thinking" | "locked" | "attack" | "hit" | "victory" | "defeat";
  matchId: string | null;
  isBotMatch: boolean;
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
  const [timeLeft, setTimeLeft] = useState(ROUND_TIME);
  const [playerPrediction, setPlayerPrediction] = useState<Prediction>(null);
  const [localPrediction, setLocalPrediction] = useState<Prediction>(null);
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null);
  const [roundHistory, setRoundHistory] = useState<RoundResult[]>([]);
  const [hitEffect, setHitEffect] = useState<"none" | "player-hit" | "rival-hit" | "both-hit">("none");
  const [shakeScreen, setShakeScreen] = useState(false);
  const [showStreak, setShowStreak] = useState<string | null>(null);
  const [playerCharState, setPlayerCharState] = useState<"idle" | "thinking" | "locked" | "attack" | "hit" | "victory" | "defeat">("idle");
  const [rivalCharState, setRivalCharState] = useState<"idle" | "thinking" | "locked" | "attack" | "hit" | "victory" | "defeat">("idle");
  const [playerScore, setPlayerScore] = useState(0);
  const [rivalScore, setRivalScore] = useState(0);
  const [predictionUIStatus, setPredictionUIStatus] = useState<"idle" | "selected" | "submitting" | "confirmed">("idle");
  const [isBotMatch, setIsBotMatch] = useState(true);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [displayRound, setDisplayRound] = useState(1);

  const animFrameRef = useRef<number>(0);
  const phaseTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const roundProcessedRef = useRef<number[]>([]);
  const botTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const botRoundRef = useRef(0);
  const botScoresRef = useRef({ player: 0, rival: 0, pStreak: 0, rStreak: 0 });
  const enteredFromIntroRef = useRef(false);
  const modeRef = useRef<GameMode | null>(null);

  // Keep refs in sync for use inside intervals/timeouts
  useEffect(() => { modeRef.current = mode; }, [mode]);

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

  // --- BOT ROUND RESOLVER (no useCallback, reads from refs) ---
  const resolveBotRoundImpl = useCallback((rNum: number, totalRounds: number) => {
    const pred = localPredictionRef.current as "UP" | "DOWN";
    const actual = randomOutcome();
    const rivalPred = Math.random() < 0.5 ? ("UP" as const) : ("DOWN" as const);
    const playerCorrect = pred === actual;
    const rivalCorrect = rivalPred === actual;
    const s = botScoresRef.current;

    const result: RoundResult = {
      roundNum: rNum,
      actual,
      playerPredicted: pred,
      rivalPredicted: rivalPred,
      playerCorrect,
      rivalCorrect,
    };
    setRoundResult(result);
    setRoundHistory((prev) => [...prev, result]);

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
      setPlayerCharState("attack");
      setRivalCharState("hit");
      setHitEffect("rival-hit");
    } else {
      s.pStreak = 0;
      setPlayerStreak(0);
      setPlayerCharState("hit");
      setRivalCharState("attack");
      setHitEffect("player-hit");
    }

    if (rivalCorrect) s.rStreak++;
    else s.rStreak = 0;
    setRivalStreak(s.rStreak);

    setShakeScreen(true);
    scheduleTimer(() => setShakeScreen(false), 400);

    setPhase("ROUND_LOCKED");
    setPlayerCharState("locked");
    setRivalCharState("locked");

    scheduleTimer(() => {
      setPhase("ROUND_REVEAL");
      scheduleTimer(() => {
        setPhase("ROUND_IMPACT");
        setHitEffect("none");
        scheduleTimer(() => {
          if (rNum >= totalRounds) {
            setPhase("MATCH_RESULT");
            const won = botScoresRef.current.player > botScoresRef.current.rival;
            setPlayerCharState(won ? "victory" : "defeat");
            setRivalCharState(won ? "defeat" : "victory");
          } else {
            setPlayerCharState("idle");
            setRivalCharState("idle");
            setLocalPrediction(null);
            setPlayerPrediction(null);
            setRoundResult(null);
            setDisplayRound(rNum + 1);
            setPhase("ROUND_START");
            scheduleTimer(() => {
              setPhase("ROUND_ACTIVE");
              setPlayerCharState("thinking");
              setRivalCharState("thinking");
            }, ROUND_TRANSITION_DELAY);
          }
        }, IMPACT_DURATION);
      }, REVEAL_DURATION);
    }, LOCK_DURATION);
  }, [scheduleTimer]);

  const localPredictionRef = useRef<Prediction>(null);
  useEffect(() => { localPredictionRef.current = localPrediction; }, [localPrediction]);

  // Resolve a bot round from a timeout (timer expired, auto-submit)
  const resolveBotTimeout = useCallback(() => {
    const totalRounds = modeRef.current?.rounds ?? 7;
    const pred: "UP" | "DOWN" = Math.random() < 0.5 ? "UP" : "DOWN";
    setLocalPrediction(pred);
    setPlayerPrediction(pred);
    resolveBotRoundImpl(botRoundRef.current + 1, totalRounds);
    botRoundRef.current++;
  }, [resolveBotRoundImpl]);

  // --- BOT COUNTDOWN TIMER ---
  // Uses useEffect keyed on phase + isBotMatch so it starts exactly once per ROUND_ACTIVE
  useEffect(() => {
    if (!isBotMatch || phase !== "ROUND_ACTIVE") return;
    if (botTimerRef.current) return;

    setTimeLeft(ROUND_TIME);
    let time = ROUND_TIME;

    botTimerRef.current = setInterval(() => {
      time = +(time - 0.1).toFixed(1);
      if (time <= 0) {
        clearInterval(botTimerRef.current!);
        botTimerRef.current = null;
        resolveBotTimeout();
        return;
      }
      setTimeLeft(time);
    }, 100);

    return () => {
      if (botTimerRef.current) { clearInterval(botTimerRef.current); botTimerRef.current = null; }
    };
  }, [isBotMatch, phase, resolveBotTimeout]);

  // Server-synced multiplayer: respond to server state changes
  useEffect(() => {
    if (isBotMatch) return;
    const ss = mp.state.serverState;
    if (!ss || ss.status !== "ACTIVE") return;

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
          setPlayerStreak((s) => { const ns = s + 1; if (ns >= 4) setShowStreak("UNSTOPPABLE"); else if (ns === 3) setShowStreak("ON_FIRE"); else if (ns === 2) setShowStreak("COMBO"); else setShowStreak("STRIKE"); return ns; });
          setPlayerCharState("attack"); setRivalCharState("hit"); setHitEffect("rival-hit");
        } else {
          setPlayerStreak(0); setPlayerCharState("hit"); setRivalCharState("attack"); setHitEffect("player-hit");
        }
        if (lastRound.rivalCorrect) setRivalScore((s) => s + 1);
        else setRivalStreak(0);
        setShakeScreen(true);
        scheduleTimer(() => setShakeScreen(false), 400);
        setPhase("ROUND_LOCKED");
        scheduleTimer(() => setPhase("ROUND_REVEAL"), LOCK_DURATION);
        scheduleTimer(() => { setPhase("ROUND_IMPACT"); setHitEffect("none"); }, LOCK_DURATION + REVEAL_DURATION);
        scheduleTimer(() => {
          if (lastRound.roundNum >= ss.totalRounds) { setPhase("MATCH_RESULT"); setPlayerCharState("victory"); setRivalCharState("defeat"); }
          else { setPlayerCharState("idle"); setRivalCharState("idle"); setDisplayRound(lastRound.roundNum + 1); setPhase("ROUND_START"); scheduleTimer(() => { setPlayerCharState("thinking"); setRivalCharState("thinking"); setPhase("ROUND_ACTIVE"); }, ROUND_TRANSITION_DELAY); }
        }, LOCK_DURATION + REVEAL_DURATION + IMPACT_DURATION);
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
    enteredFromIntroRef.current = true;

    scheduleTimer(() => {
      setPhase("ROUND_START");
      scheduleTimer(() => {
        setPhase("ROUND_ACTIVE");
        setPlayerCharState("thinking");
        setRivalCharState("thinking");
      }, ROUND_TRANSITION_DELAY);
    }, MATCH_INTRO_DURATION);
  }, [playerChar, mode, scheduleTimer]);

  // --- PREDICTION ---
  const makePrediction = useCallback(async (pred: "UP" | "DOWN") => {
    if (phase !== "ROUND_ACTIVE" || localPrediction !== null) return;

    // Optimistic UI: instant feedback
    setLocalPrediction(pred);
    setPlayerPrediction(pred);
    setPredictionUIStatus("selected");
    setPlayerCharState("locked");

    if (isBotMatch) {
      // Stop the timer, resolve locally
      if (botTimerRef.current) { clearInterval(botTimerRef.current); botTimerRef.current = null; }
      const totalRounds = mode?.rounds ?? 7;
      resolveBotRoundImpl(botRoundRef.current + 1, totalRounds);
      botRoundRef.current++;
      setPredictionUIStatus("confirmed");
      return;
    }

    // Multiplayer: submit to server
    setPredictionUIStatus("submitting");
    const result = await mp.actions.submitPrediction(pred);
    setPredictionUIStatus(result ? "confirmed" : "confirmed");
  }, [phase, localPrediction, isBotMatch, mode, resolveBotRoundImpl, mp.actions]);

  const rematch = useCallback(() => {
    clearAllTimers();
    mp.actions.reset();
    roundProcessedRef.current = [];
    botRoundRef.current = 0;
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
  }, [clearAllTimers, mp.actions]);

  const goToHome = useCallback(() => { clearAllTimers(); mp.actions.reset(); setPhase("HOME"); roundProcessedRef.current = []; }, [clearAllTimers, mp.actions]);
  const goToModeSelect = useCallback(() => { setPhase("MODE_SELECT"); }, []);
  const goToCharSelect = useCallback(() => { clearAllTimers(); mp.actions.reset(); setPhase("CHAR_SELECT"); roundProcessedRef.current = []; }, [clearAllTimers, mp.actions]);
  const goToLeaderboard = useCallback(() => { setPhase("HOME"); }, []);
  const selectMode = useCallback((m: GameMode) => { setMode(m); setPhase("CHAR_SELECT"); }, []);
  const selectChar = useCallback((c: CharacterDef) => { setPlayerChar(c); setPhase("DUEL_CONFIRM"); }, []);
  const confirmDuel = useCallback(() => { startMatch(); }, [startMatch]);

  const joinMatchmaking = useCallback((selectedRounds: number) => {
    clearAllTimers();
    roundProcessedRef.current = [];
    botRoundRef.current = 0;
    setIsBotMatch(false);
    setMode(GAME_MODES.find((m) => m.rounds === selectedRounds) ?? GAME_MODES[2]);
    setPhase("MATCHMAKING");
  }, [clearAllTimers]);

  const startPvPMatch = useCallback((pvpMatchId: string) => {
    clearAllTimers();
    roundProcessedRef.current = [];
    botRoundRef.current = 0;
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
    actions: {
      goToHome, goToModeSelect, goToCharSelect, goToLeaderboard,
      selectMode, selectChar, confirmDuel, makePrediction, rematch,
      joinMatchmaking, startPvPMatch, setReady, cancelMatchmaking, fightBotInstead,
    },
  };
}
