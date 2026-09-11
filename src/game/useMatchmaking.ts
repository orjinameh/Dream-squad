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
  joinQueue: (rounds: number, charId: string, amountPerRound?: number) => Promise<void>;
  leaveQueue: () => Promise<void>;
  reset: () => void;
}

export type RoomStatus = "idle" | "waiting" | "matched" | "error";

export interface RoomState {
  status: RoomStatus;
  code: string | null;
  matchId: string | null;
  rounds: number;
  error: string | null;
}

export interface RoomActions {
  createRoom: (rounds: number, charId: string, amountPerRound?: number) => Promise<string | null>;
  joinRoom: (code: string, charId?: string, amountPerRound?: number) => Promise<string | null>;
  leaveRoom: () => Promise<void>;
}

const POLL_INTERVAL = 1500;
const TIMEOUT_MS = 120000;

export function useMatchmaking(walletAddress?: `0x${string}`): {
  state: MatchmakingState;
  actions: MatchmakingActions;
  room: RoomState;
  roomActions: RoomActions;
} {
  const [status, setStatus] = useState<MatchmakingStatus>("idle");
  const [matchId, setMatchId] = useState<string | null>(null);
  const [queueId, setQueueId] = useState<string | null>(null);
  const [rounds, setRounds] = useState(7);
  const [age, setAge] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusRef = useRef<MatchmakingStatus>("idle");
  const rejoiningRef = useRef(false);
  const roomPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Private rooms ──────────────────────────────────────────────────────
  const [roomStatus, setRoomStatus] = useState<RoomStatus>("idle");
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [roomMatchId, setRoomMatchId] = useState<string | null>(null);
  const [roomRounds, setRoomRounds] = useState(7);
  const [roomError, setRoomError] = useState<string | null>(null);

  const stopRoomPolling = useCallback(() => {
    if (roomPollingRef.current) { clearInterval(roomPollingRef.current); roomPollingRef.current = null; }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);
  useEffect(() => () => stopRoomPolling(), [stopRoomPolling]);

  // Keep statusRef in sync
  useEffect(() => { statusRef.current = status; }, [status]);

  const performJoin = useCallback(async (roundsSelected: number, charId: string, amountPerRound?: number): Promise<void> => {
    if (!walletAddress) return;
    setError(null);
    setRounds(roundsSelected);

    const checkActiveMatch = async (): Promise<string | null> => {
      try {
        const res = await fetch(`/api/matches/active?address=${walletAddress}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data?.active && data?.matchId ? data.matchId : null;
      } catch {
        return null;
      }
    };

    try {
      const res = await fetch("/api/matchmaking/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: walletAddress, rounds: roundsSelected, charId, ...(amountPerRound != null ? { amountPerRound } : {}) }),
      });
      const data = await res.json();

      if (!res.ok) {
        setStatus("error");
        setError(data.error || "Failed to join queue");
        stopPolling();
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

      // Searching — set up (or keep) the poll loop.
      setQueueId(data.queueId);
      setStatus("searching");

      if (!pollingRef.current) {
        pollingRef.current = setInterval(async () => {
          try {
            const pollRes = await fetch(`/api/matchmaking/status?address=${walletAddress}`);
            const pollData = await pollRes.json();

            if (pollData.status === "matched") {
              setStatus("matched");
              setMatchId(pollData.matchId);
              stopPolling();
            } else if (pollData.status === "timeout") {
              setStatus("timeout");
              stopPolling();
            } else if (pollData.status === "idle" || pollData.status === "searching") {
              // Fallback: the queue/status view can lag behind an actual match
              // (e.g. a re-joined queue entry vs. the server-authoritative match
              // record). Before self-healing on idle or spinning forever on
              // searching, check whether we are genuinely in an active match and
              // transition straight in if so.
              const activeMatchId = await checkActiveMatch();
              if (activeMatchId) {
                setStatus("matched");
                setMatchId(activeMatchId);
                stopPolling();
                return;
              }

              if (pollData.status === "idle") {
                // Our queue entry was consumed (pairing raced / match this player
                // created didn't complete) and we have no active match. Self-heal:
                // re-join exactly once to re-establish the search rather than
                // freezing on a dead bare screen.
                if (!rejoiningRef.current) {
                  rejoiningRef.current = true;
                  try {
                    await performJoin(roundsSelected, charId, amountPerRound);
                  } finally {
                    rejoiningRef.current = false;
                  }
                }
              }
            } else {
              setAge(pollData.age || 0);
            }
          } catch {
            // Network error — keep polling
          }
        }, POLL_INTERVAL);
      }
    } catch {
      setStatus("error");
      setError("Network error");
      stopPolling();
    }
  }, [walletAddress, stopPolling]);

  const joinQueue = useCallback(async (roundsSelected: number, charId: string, amountPerRound?: number) => {
    if (!walletAddress) return;
    stopPolling();
    setStatus("searching");
    await performJoin(roundsSelected, charId, amountPerRound);
  }, [walletAddress, stopPolling, performJoin]);

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
    stopRoomPolling();
    setStatus("idle");
    setMatchId(null);
    setQueueId(null);
    setError(null);
    setAge(0);
    setRoomStatus("idle");
    setRoomCode(null);
    setRoomMatchId(null);
    setRoomError(null);
  }, [stopPolling, stopRoomPolling]);

  const createRoom = useCallback(async (roundsSelected: number, charId: string, amountPerRound?: number): Promise<string | null> => {
    if (!walletAddress) return null;
    // A wallet fights in one place at a time — exit the public search first.
    stopPolling();
    setStatus("idle");
    stopRoomPolling();
    setRoomError(null);
    setRoomMatchId(null);
    setRoomRounds(roundsSelected);
    try {
      const res = await fetch("/api/matchmaking/room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: walletAddress,
          rounds: roundsSelected,
          charId,
          ...(amountPerRound != null ? { amountPerRound } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Already in an active match → hand it over like the queue does.
        if (data?.status === "matched" && data?.matchId) {
          setRoomStatus("matched");
          setRoomMatchId(data.matchId);
          return data.matchId;
        }
        setRoomStatus("error");
        setRoomError(data?.error || "Failed to create room");
        return null;
      }
      setRoomCode(data.code);
      setRoomStatus("waiting");
      // Host idle lobby: lightweight poll of the spec gate
      // (GET /api/matchmaking/status?code=...) until the guest claims it.
      roomPollingRef.current = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/matchmaking/status?code=${encodeURIComponent(data.code)}`);
          const pollData = await pollRes.json();
          if (!pollRes.ok) {
            setRoomStatus("error");
            setRoomError(pollData?.error || "Room lost");
            stopRoomPolling();
            return;
          }
          if (pollData.status === "matched" && pollData.matchId) {
            setRoomStatus("matched");
            setRoomMatchId(pollData.matchId);
            stopRoomPolling();
          }
        } catch {
          /* keep polling */
        }
      }, POLL_INTERVAL);
      return data.code as string;
    } catch {
      setRoomStatus("error");
      setRoomError("Network error");
      return null;
    }
  }, [walletAddress, stopPolling, stopRoomPolling]);

  const joinRoom = useCallback(async (code: string, charId?: string, amountPerRound?: number): Promise<string | null> => {
    const clean = code.trim().toUpperCase();
    if (!walletAddress || !/^DUEL-[A-Z2-9]{4}$/.test(clean)) {
      setRoomStatus("error");
      setRoomError("Enter the invite code (DUEL-XXXX)");
      return null;
    }
    stopPolling();
    setStatus("idle");
    stopRoomPolling();
    setRoomError(null);
    setRoomMatchId(null);
    setRoomCode(clean);
    try {
      const res = await fetch("/api/matchmaking/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: walletAddress,
          code: clean,
          charId: charId || "dreamer",
          ...(amountPerRound != null ? { amountPerRound } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || data?.status !== "matched" || !data?.matchId) {
        setRoomStatus("error");
        setRoomError(data?.error || "Failed to join room");
        return null;
      }
      setRoomStatus("matched");
      setRoomMatchId(data.matchId);
      return data.matchId as string;
    } catch {
      setRoomStatus("error");
      setRoomError("Network error");
      return null;
    }
  }, [walletAddress, stopPolling, stopRoomPolling]);

  const leaveRoom = useCallback(async () => {
    stopRoomPolling();
    try {
      if (walletAddress && roomCode && roomStatus === "waiting") {
        await fetch(`/api/matchmaking/room?code=${encodeURIComponent(roomCode)}&address=${encodeURIComponent(walletAddress)}`, {
          method: "DELETE",
        });
      }
    } catch { /* best effort */ }
    setRoomStatus("idle");
    setRoomCode(null);
    setRoomMatchId(null);
    setRoomError(null);
  }, [walletAddress, roomCode, roomStatus, stopRoomPolling]);

  return {
    state: { status, matchId, queueId, rounds, age, error },
    actions: { joinQueue, leaveQueue, reset },
    room: { status: roomStatus, code: roomCode, matchId: roomMatchId, rounds: roomRounds, error: roomError },
    roomActions: { createRoom, joinRoom, leaveRoom },
  };
}
