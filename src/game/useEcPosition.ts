import { useEffect, useState, useCallback } from "react";

export type EcPosition = {
  asset: string;
  marketId: string | null;
  symbol?: string;
  live: boolean;
  remainingSec: number;
  yesPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  arenaOpen: number | null;
  direction: "UP" | "DOWN" | "FLAT" | null;
  updatedMs?: number;
};

/**
 * Polls the live Event-Contract position for a match (see
 * /api/matches/ec-position). Real on-chain data — current EC YES price vs the
 * match's pinned window-open anchor — never simulated. Stops when matchId is
 * absent.
 */
export function useEcPosition(matchId?: string | null, pollMs = 4000) {
  const [pos, setPos] = useState<EcPosition | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!matchId) return;
    try {
      const res = await fetch(`/api/matches/ec-position?matchId=${encodeURIComponent(matchId)}`, {
        signal: signal ?? AbortSignal.timeout(8000),
      });
      if (!res.ok) return;
      setPos((await res.json()) as EcPosition);
    } catch {
      /* transient — retry next tick */
    }
  }, [matchId]);

  useEffect(() => {
    if (!matchId) {
      setPos(null);
      return;
    }
    let active = true;
    const ctrl = new AbortController();
    let inFlight = false;
    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      try { await load(ctrl.signal); } finally { inFlight = false; }
      if (!active) return;
    };
    run();
    const iv = setInterval(() => {
      if (active) run();
    }, pollMs);
    return () => {
      active = false;
      ctrl.abort();
      clearInterval(iv);
    };
  }, [matchId, pollMs, load]);

  return { pos, refetch: load };
}
