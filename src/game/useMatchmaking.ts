"use client";

import { useState, useCallback, useRef, useEffect } from "react";

export type MatchmakingStatus = "idle" | "searching" | "matched" | "timeout" | "error";

export interface MatchmakingState {
  status: MatchmakingStatus;
  matchId: string | null;
  queueId: string | null;
  rounds: number;
  age: number;
  error: string | null;
}

export interface MatchmakingActions {
  joinQueue: (rounds: number, charId: string) => Promise<void>;
  leaveQueue: () => Promise<void>;
  reset: () => void;
}

const POLL_INTERVAL = 1500;
const TIMEOUT_MS = 120000;

export function useMatchmaking(walletAddress?: `0x${string}`): {
  state: MatchmakingState;
  actions: MatchmakingActions;
} {
  const [status, setStatus] = useState<MatchmakingStatus>("idle");
  const [matchId, setMatchId] = useState<string | null>(null);
  const [queueId, setQueueId] = useState<string | null>(null);
  const [rounds, setRounds] = useState(7);
  const [age, setAge] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusRef = useRef<MatchmakingStatus>("idle");

  const stopPolling = useCallback(() => {
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // Keep statusRef in sync
  useEffect(() => { statusRef.current = status; }, [status]);

  const joinQueue = useCallback(async (roundsSelected: number, charId: string) => {
    if (!walletAddress) return;
    setError(null);
    setStatus("searching");
    setRounds(roundsSelected);

    try {
      const res = await fetch("/api/matchmaking/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: walletAddress, rounds: roundsSelected, charId }),
      });
      const data = await res.json();

      if (!res.ok) {
        setStatus("error");
        setError(data.error || "Failed to join queue");
        return;
      }

      if (data.status === "matched") {
        setStatus("matched");
        setMatchId(data.matchId);
        stopPolling();
        return;
      }

      if (data.status === "timeout") {
        setStatus("timeout");
        stopPolling();
        return;
      }

      // Searching — start polling
      setQueueId(data.queueId);
      setStatus("searching");

      stopPolling();
      pollingRef.current = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/matchmaking/status?address=${walletAddress}`);
          const pollData = await pollRes.json();

          if (pollData.status === "matched") {
            setStatus("matched");
            setMatchId(pollData.matchId);
            stopPolling();
          } else if (pollData.status === "idle" || pollData.status === "timeout") {
            setStatus(pollData.status === "timeout" ? "timeout" : "idle");
            stopPolling();
          } else {
            setAge(pollData.age || 0);
          }
        } catch {
          // Network error — keep polling
        }
      }, POLL_INTERVAL);
    } catch {
      setStatus("error");
      setError("Network error");
    }
  }, [walletAddress, stopPolling]);

  const leaveQueue = useCallback(async () => {
    if (!walletAddress) return;
    stopPolling();
    try {
      await fetch("/api/matchmaking/leave", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: walletAddress }),
      });
    } catch { /* best effort */ }
    setStatus("idle");
    setQueueId(null);
    setMatchId(null);
  }, [walletAddress, stopPolling]);

  const reset = useCallback(() => {
    stopPolling();
    setStatus("idle");
    setMatchId(null);
    setQueueId(null);
    setError(null);
    setAge(0);
  }, [stopPolling]);

  return {
    state: { status, matchId, queueId, rounds, age, error },
    actions: { joinQueue, leaveQueue, reset },
  };
}
