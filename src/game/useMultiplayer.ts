"use client";

import { useState, useCallback, useRef, useEffect } from "react";

const POLL_INTERVAL_MS = 800;
const PING_HISTORY_SIZE = 8;
const RECONNECT_INTERVAL_MS = 1500;

export type ConnectionStatus = "local" | "offline" | "connecting" | "good" | "high" | "reconnecting";

export interface ServerMatchState {
  matchId: string;
  status: "ACTIVE" | "COMPLETED" | "ABANDONED";
  mode: string;
  totalRounds: number;
  currentRound: number;
  roundPhase: "WAITING" | "ACTIVE" | "EXECUTING" | "REVEALED" | "TRANSITIONING";
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
    roundWinner?: "player" | "rival" | "draw";
    damage?: number;
    playerDamage?: number;
    rivalDamage?: number;
    isCritical?: boolean;
    knockout?: boolean;
    startPrice?: number;
    endPrice?: number;
    prices?: number[];
    asset?: string;
    playerPnL?: number;
    rivalPnL?: number;
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
  playerChar?: string;
  rivalChar?: string;
  rivalName?: string;
  // Server-authoritative combat
  playerHP: number;
  rivalHP: number;
  playerStreak: number;
  rivalStreak: number;
  lastRound?: {
    roundNum: number;
    playerPrediction: "UP" | "DOWN" | null;
    rivalPrediction: "UP" | "DOWN" | null;
    actual: "UP" | "DOWN";
    playerCorrect: boolean;
    rivalCorrect: boolean;
    roundWinner?: "player" | "rival" | "draw";
    damage?: number;
    playerDamage?: number;
    rivalDamage?: number;
    isCritical?: boolean;
    knockout?: boolean;
    playerExecution?: any;
    rivalExecution?: any;
  };
  opponentType?: string;
  funded?: boolean;
  hasOpponent?: boolean;
  botDifficulty?: string;
  player1Ready?: boolean;
  player2Ready?: boolean;
    predictionAsset?: string;
  predictionQuestion?: string;
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
}

export interface CreateMatchResult {
  matchId: string;
  serverTime: string;
  roundStartTime: string;
  roundDeadline: string;
}

export interface PredictionResult {
  serverTime: string;
  roundPhase: string;
  roundDeadline: string;
  playerScore: number;
  rivalScore: number;
  playerPrediction: "UP" | "DOWN";
  rivalPrediction: "UP" | "DOWN";
  rounds: ServerMatchState["rounds"];
  winner: string;
  totalRounds: number;
  currentRound: number;
}

export interface MultiplayerState {
  serverState: ServerMatchState | null;
  connectionStatus: ConnectionStatus;
  pingMs: number;
  clockOffsetMs: number;
  serverTimeNow: Date;
  isLoading: boolean;
  predictionStatus: "idle" | "submitting" | "confirmed" | "error";
  lastError: string | null;
}

export interface MultiplayerActions {
  createMatch: (input: {
    playerAddress: string;
    playerChar: string;
    rivalName: string;
    rivalChar: string;
    mode: string;
    totalRounds: number;
    predictionAsset?: string;
    amountPerRound?: number;
    marketSymbol?: string;
    positionId?: string;
  }) => Promise<CreateMatchResult>;
  fetchState: () => Promise<ServerMatchState | null>;
  submitPrediction: (prediction: "UP" | "DOWN" | null | undefined) => Promise<PredictionResult | null>;
  reconnectToMatch: (matchId: string) => Promise<ServerMatchState | null>;
  detectActiveMatch: (address: string) => Promise<{ active: boolean; matchId?: string; opponentType?: string }>;
  reset: () => void;
  setAddress: (addr: string) => void;
  getServerNow: () => Date;
  getTimeRemaining: () => number;
}

export interface UseMultiplayerReturn {
  state: MultiplayerState;
  actions: MultiplayerActions;
}

export function useMultiplayer(): UseMultiplayerReturn {
  const [serverState, setServerState] = useState<ServerMatchState | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("offline");
  const [pingMs, setPingMs] = useState(0);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [predictionStatus, setPredictionStatus] = useState<"idle" | "submitting" | "confirmed" | "error">("idle");
  const [lastError, setLastError] = useState<string | null>(null);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pingHistoryRef = useRef<number[]>([]);
  const currentMatchIdRef = useRef<string | null>(null);
  const playerAddressRef = useRef<string | null>(null);

  const clearInterval_ = useCallback((ref: React.MutableRefObject<ReturnType<typeof setInterval> | null>) => {
    if (ref.current) {
      clearInterval(ref.current);
      ref.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearInterval_(pollingRef);
      clearInterval_(reconnectRef);
    };
  }, [clearInterval_]);

  const measurePing = useCallback((startMs: number) => {
    const rtt = Date.now() - startMs;
    pingHistoryRef.current.push(rtt);
    if (pingHistoryRef.current.length > PING_HISTORY_SIZE) {
      pingHistoryRef.current.shift();
    }
    const avg = pingHistoryRef.current.reduce((a, b) => a + b, 0) / pingHistoryRef.current.length;
    setPingMs(Math.round(avg));
  }, []);

  const updateClockOffset = useCallback((serverTime: string, requestSentMs: number) => {
    const serverMs = new Date(serverTime).getTime();
    const roundTrip = Date.now() - requestSentMs;
    const estimatedServerNow = serverMs + roundTrip / 2;
    setClockOffsetMs(estimatedServerNow - Date.now());
  }, []);

  const getServerNow = useCallback(() => {
    return new Date(Date.now() + clockOffsetMs);
  }, [clockOffsetMs]);

  const getTimeRemaining = useCallback(() => {
    if (!serverState || serverState.roundPhase !== "ACTIVE") return 0;
    const deadline = new Date(serverState.roundDeadline).getTime();
    const now = getServerNow().getTime();
    const remaining = (deadline - now) / 1000;
    return Math.max(0, remaining);
  }, [serverState, getServerNow]);

  const pollState = useCallback(async (matchId: string) => {
    const sent = Date.now();
    try {
      const addrParam = playerAddressRef.current ? `&address=${encodeURIComponent(playerAddressRef.current)}` : "";
      const res = await fetch(`/api/matches/state?matchId=${encodeURIComponent(matchId)}${addrParam}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ServerMatchState = await res.json();
      measurePing(sent);
      updateClockOffset(data.serverTime, sent);
      setServerState(data);
      setConnectionStatus((prev) => {
        if (prev === "reconnecting") return "good";
        if (pingMs > 500) return "high";
        return "good";
      });
      currentMatchIdRef.current = matchId;
      return data;
    } catch {
      setConnectionStatus("reconnecting");
      return null;
    }
  }, [measurePing, updateClockOffset, pingMs]);

  const startPolling = useCallback((matchId: string) => {
    clearInterval_(pollingRef);
    currentMatchIdRef.current = matchId;
    setConnectionStatus("connecting");

    const doPoll = async () => {
      const data = await pollState(matchId);
      if (data && data.status !== "ACTIVE") {
        clearInterval_(pollingRef);
      }
    };

    doPoll();
    pollingRef.current = setInterval(doPoll, POLL_INTERVAL_MS);
  }, [clearInterval_, pollState]);

  const startReconnecting = useCallback((matchId: string) => {
    clearInterval_(reconnectRef);
    setConnectionStatus("reconnecting");

    reconnectRef.current = setInterval(async () => {
      try {
        const addrParam = playerAddressRef.current ? `&address=${encodeURIComponent(playerAddressRef.current)}` : "";
        const res = await fetch(`/api/matches/state?matchId=${encodeURIComponent(matchId)}${addrParam}`);
        if (!res.ok) return;
        const data: ServerMatchState = await res.json();
        setServerState(data);
        setConnectionStatus("good");
        currentMatchIdRef.current = matchId;
        clearInterval_(reconnectRef);
        startPolling(matchId);
      } catch {
        /* keep retrying */
      }
    }, RECONNECT_INTERVAL_MS);
  }, [clearInterval_, startPolling]);

  const createMatch = useCallback(async (input: {
    playerAddress: string;
    playerChar: string;
    rivalName: string;
    rivalChar: string;
    mode: string;
    totalRounds: number;
    predictionAsset?: string;
    amountPerRound?: number;
    marketSymbol?: string;
    positionId?: string;
  }): Promise<CreateMatchResult> => {
    setIsLoading(true);
    setLastError(null);
    try {
      const res = await fetch("/api/matches/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, predictionAsset: input.predictionAsset ?? "BTC" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data: CreateMatchResult = await res.json();
      setServerState({
        matchId: data.matchId,
        status: "ACTIVE",
        mode: input.mode,
        totalRounds: input.totalRounds,
        currentRound: 1,
        roundPhase: "ACTIVE",
        roundStartTime: data.roundStartTime,
        roundDeadline: data.roundDeadline,
        serverTime: data.serverTime,
        playerScore: 0,
        rivalScore: 0,
        playerPrediction: null,
        rivalPrediction: null,
        rounds: [],
        winner: "player",
        playerChar: input.playerChar,
        rivalChar: input.rivalChar,
        rivalName: input.rivalName,
        playerHP: 100,
        rivalHP: 100,
        playerStreak: 0,
        rivalStreak: 0,
        playerBalance: 100,
        rivalBalance: 100,
        playerStartBalance: 100,
        rivalStartBalance: 100,
        playerAmountPerRound: input.amountPerRound ?? 1,
        rivalAmountPerRound: 1,
      });
      startPolling(data.matchId);
      setIsLoading(false);
      return data;
    } catch (err) {
      setIsLoading(false);
      setLastError(err instanceof Error ? err.message : "failed to create match");
      throw err;
    }
  }, [startPolling]);

  const fetchState = useCallback(async (): Promise<ServerMatchState | null> => {
    const id = currentMatchIdRef.current;
    if (!id) return null;
    return pollState(id);
  }, [pollState]);

  const submitPrediction = useCallback(async (prediction: "UP" | "DOWN" | null | undefined): Promise<PredictionResult | null> => {
    const matchId = currentMatchIdRef.current;
    if (!matchId || !playerAddressRef.current) return null;

    setPredictionStatus("submitting");
    setLastError(null);

    try {
      const res = await fetch("/api/matches/predict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          matchId,
          playerAddress: playerAddressRef.current,
          prediction,
          clientTimestamp: new Date().toISOString(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        setPredictionStatus("error");
        setLastError(err.error || `HTTP ${res.status}`);
        return null;
      }
      const data: PredictionResult = await res.json();
      setPredictionStatus("confirmed");
      setTimeout(() => setPredictionStatus("idle"), 2000);

      // Update local state from prediction response
      setServerState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          serverTime: data.serverTime,
          roundPhase: data.roundPhase as ServerMatchState["roundPhase"],
          roundDeadline: data.roundDeadline,
          playerScore: data.playerScore,
          rivalScore: data.rivalScore,
          playerPrediction: data.playerPrediction,
          rivalPrediction: data.rivalPrediction,
          rounds: data.rounds,
          winner: data.winner,
          totalRounds: data.totalRounds,
          currentRound: data.currentRound,
          playerAmountPerRound: (data as any).playerAmountPerRound ?? prev.playerAmountPerRound,
          rivalAmountPerRound: (data as any).rivalAmountPerRound ?? prev.rivalAmountPerRound,
        };
      });

      return data;
    } catch (err) {
      setPredictionStatus("error");
      setLastError(err instanceof Error ? err.message : "failed to submit prediction");
      return null;
    }
  }, []);

  const reconnectToMatch = useCallback(async (matchId: string): Promise<ServerMatchState | null> => {
    setIsLoading(true);
    try {
      const addrParam = playerAddressRef.current ? `&address=${encodeURIComponent(playerAddressRef.current)}` : "";
      const res = await fetch(`/api/matches/state?matchId=${encodeURIComponent(matchId)}${addrParam}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ServerMatchState = await res.json();
      setServerState(data);
      currentMatchIdRef.current = matchId;
      setIsLoading(false);
      if (data.status === "ACTIVE") {
        startPolling(matchId);
      }
      return data;
    } catch {
      setIsLoading(false);
      startReconnecting(matchId);
      return null;
    }
  }, [startPolling, startReconnecting]);

  const detectActiveMatch = useCallback(async (address: string) => {
    try {
      const res = await fetch(`/api/matches/active?address=${encodeURIComponent(address)}`);
      if (!res.ok) return { active: false };
      return await res.json();
    } catch {
      return { active: false };
    }
  }, []);

  const reset = useCallback(() => {
    clearInterval_(pollingRef);
    clearInterval_(reconnectRef);
    setServerState(null);
    setConnectionStatus("offline");
    setPingMs(0);
    setClockOffsetMs(0);
    setIsLoading(false);
    setPredictionStatus("idle");
    setLastError(null);
    currentMatchIdRef.current = null;
    pingHistoryRef.current = [];
  }, [clearInterval_]);

  const setAddress = useCallback((addr: string) => {
    playerAddressRef.current = addr;
  }, []);

  return {
    state: {
      serverState,
      connectionStatus,
      pingMs,
      clockOffsetMs,
      serverTimeNow: getServerNow(),
      isLoading,
      predictionStatus,
      lastError,
    },
    actions: {
      createMatch,
      fetchState,
      submitPrediction,
      reconnectToMatch,
      detectActiveMatch,
      reset,
      setAddress,
      getServerNow,
      getTimeRemaining,
    },
  };
}
