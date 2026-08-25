"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { type CharacterDef, CHARACTERS, RIVAL_NAMES } from "./characters";
import { type GamePhase, type GameMode, type Prediction, type RoundResult, GAME_MODES } from "./types";

const ROUND_TIME = 10;
const LOCK_DURATION = 1200;
const REVEAL_DURATION = 1500;
const IMPACT_DURATION = 1400;
const MATCH_INTRO_DURATION = 2000;

function randomPrediction(): Prediction {
  return Math.random() < 0.5 ? "UP" : "DOWN";
}

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
  makePrediction: (pred: Prediction) => void;
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
  actions: GameActions;
}

export function useGameState(): GameHook {
  const [phase, setPhase] = useState<GamePhase>("HOME");
  const [mode, setMode] = useState<GameMode | null>(null);
  const [playerChar, setPlayerChar] = useState<CharacterDef | null>(null);
  const [rivalChar, setRivalChar] = useState<CharacterDef | null>(null);
  const [rivalName, setRivalName] = useState("");
  const [currentRound, setCurrentRound] = useState(0);
  const [playerScore, setPlayerScore] = useState(0);
  const [rivalScore, setRivalScore] = useState(0);
  const [playerStreak, setPlayerStreak] = useState(0);
  const [rivalStreak, setRivalStreak] = useState(0);
  const [timeLeft, setTimeLeft] = useState(ROUND_TIME);
  const [playerPrediction, setPlayerPrediction] = useState<Prediction>(null);
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null);
  const [roundHistory, setRoundHistory] = useState<RoundResult[]>([]);
  const [hitEffect, setHitEffect] = useState<"none" | "player-hit" | "rival-hit" | "both-hit">("none");
  const [shakeScreen, setShakeScreen] = useState(false);
  const [showStreak, setShowStreak] = useState<string | null>(null);
  const [playerCharState, setPlayerCharState] = useState<"idle" | "thinking" | "locked" | "attack" | "hit" | "victory" | "defeat">("idle");
  const [rivalCharState, setRivalCharState] = useState<"idle" | "thinking" | "locked" | "attack" | "hit" | "victory" | "defeat">("idle");
  const [matchId, setMatchId] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const resolveRound = useCallback((prediction: Prediction, rNum: number, total: number) => {
    const actual = randomOutcome();
    const rivalPred = randomPrediction();
    const playerCorrect = prediction === actual;
    const rivalCorrect = rivalPred === actual;

    const result: RoundResult = {
      roundNum: rNum,
      actual,
      playerPredicted: prediction,
      rivalPredicted: rivalPred,
      playerCorrect,
      rivalCorrect,
    };

    setRoundResult(result);
    setRoundHistory((prev) => [...prev, result]);

    if (playerCorrect) {
      setPlayerScore((s) => s + 1);
      setPlayerStreak((s) => {
        const newStreak = s + 1;
        if (newStreak >= 4) setShowStreak("UNSTOPPABLE");
        else if (newStreak === 3) setShowStreak("ON_FIRE");
        else if (newStreak === 2) setShowStreak("COMBO");
        else setShowStreak("STRIKE");
        return newStreak;
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

    if (rivalCorrect) {
      setRivalScore((s) => s + 1);
      setRivalStreak((s) => s + 1);
    } else {
      setRivalStreak(0);
    }

    setShakeScreen(true);
    setTimeout(() => setShakeScreen(false), 400);

    // LOCKED phase
    setPhase("ROUND_LOCKED");
    setPlayerCharState("locked");
    setRivalCharState("locked");

    timeoutRef.current = setTimeout(() => {
      // REVEAL phase
      setPhase("ROUND_REVEAL");
      timeoutRef.current = setTimeout(() => {
        // IMPACT phase
        setPhase("ROUND_IMPACT");
        setHitEffect("none");

        timeoutRef.current = setTimeout(() => {
          // Next round or match end
          if (rNum >= total) {
            setPhase("MATCH_RESULT");
            setPlayerCharState("victory");
            setRivalCharState("defeat");
          } else {
            setCurrentRound(rNum + 1);
            setPlayerPrediction(null);
            setRoundResult(null);
            setPlayerCharState("idle");
            setRivalCharState("idle");
            setPhase("ROUND_START");

            timeoutRef.current = setTimeout(() => {
              setPhase("ROUND_ACTIVE");
              setPlayerCharState("thinking");
              setRivalCharState("thinking");
              setTimeLeft(ROUND_TIME);
            }, 800);
          }
        }, IMPACT_DURATION);
      }, REVEAL_DURATION);
    }, LOCK_DURATION);
  }, []);

  const startRoundTimer = useCallback(() => {
    setTimeLeft(ROUND_TIME);
    setPhase("ROUND_ACTIVE");
    setPlayerCharState("thinking");
    setRivalCharState("thinking");

    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 0.1) {
          clearTimers();
          // Auto-lock with null prediction (no prediction = wrong)
          resolveRound(null, currentRound, mode?.rounds ?? 7);
          return 0;
        }
        return +(prev - 0.1).toFixed(1);
      });
    }, 100);
  }, [clearTimers, resolveRound, currentRound, mode]);

  const startMatch = useCallback(async () => {
    setPhase("MATCH_INTRO");
    const rival = CHARACTERS.filter((c) => c.id !== playerChar?.id);
    const rc = rival[Math.floor(Math.random() * rival.length)];
    const rn = RIVAL_NAMES[Math.floor(Math.random() * RIVAL_NAMES.length)];
    setRivalChar(rc);
    setRivalName(rn);

    // Create match on backend
    try {
      const res = await fetch("/api/matches/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playerAddress: "0x0000000000000000000000000000000000000000",
          playerChar: playerChar?.id ?? "dreamer",
          rivalName: rn,
          rivalChar: rc.id,
          mode: mode?.id ?? "battle",
          totalRounds: mode?.rounds ?? 7,
        }),
      });
      const data = await res.json();
      setMatchId(data.matchId ?? null);
    } catch {
      // Continue even if backend is unavailable
    }

    setCurrentRound(1);
    setPlayerScore(0);
    setRivalScore(0);
    setPlayerStreak(0);
    setRivalStreak(0);
    setRoundHistory([]);
    setRoundResult(null);
    setPlayerPrediction(null);
    setHitEffect("none");
    setShakeScreen(false);
    setShowStreak(null);
    setPlayerCharState("idle");
    setRivalCharState("idle");

    setTimeout(() => {
      setPhase("ROUND_START");
      setTimeout(() => startRoundTimer(), 800);
    }, MATCH_INTRO_DURATION);
  }, [playerChar, mode, startRoundTimer]);

  const makePrediction = useCallback((pred: Prediction) => {
    if (phase !== "ROUND_ACTIVE") return;
    clearTimers();
    setPlayerPrediction(pred);
    resolveRound(pred, currentRound, mode?.rounds ?? 7);
  }, [phase, clearTimers, resolveRound, currentRound, mode]);

  const rematch = useCallback(() => {
    clearTimers();
    setPhase("CHAR_SELECT");
    setPlayerPrediction(null);
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
  }, [clearTimers]);

  const goToHome = useCallback(() => { clearTimers(); setPhase("HOME"); }, [clearTimers]);
  const goToModeSelect = useCallback(() => { clearTimers(); setPhase("MODE_SELECT"); }, [clearTimers]);
  const goToCharSelect = useCallback(() => { clearTimers(); setPhase("CHAR_SELECT"); }, [clearTimers]);
  const goToLeaderboard = useCallback(() => { clearTimers(); setPhase("HOME"); }, [clearTimers]);

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

  return {
    phase, mode, playerChar, rivalChar, rivalName,
    currentRound, totalRounds: mode?.rounds ?? 7,
    playerScore, rivalScore, playerStreak, rivalStreak,
    timeLeft, playerPrediction, roundResult, roundHistory,
    hitEffect, shakeScreen, showStreak,
    playerCharState, rivalCharState, matchId,
    actions: {
      goToHome, goToModeSelect, goToCharSelect, goToLeaderboard,
      selectMode, selectChar, confirmDuel, makePrediction, rematch,
    },
  };
}
