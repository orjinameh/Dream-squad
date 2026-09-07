"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

interface TapePoint {
  t: number; // unix seconds
  p: number; // YES probability in [0.01, 0.99]
}

interface TapeResponse {
  asset: string;
  marketId: string | null;
  symbol: string | null;
  live: boolean;
  reason?: string;
  points: TapePoint[];
  edge: TapePoint | null;
  entry: number | null;
  direction: "UP" | "DOWN" | "FLAT" | null;
}

interface Props {
  matchId?: string | null;
  asset?: string;
  height?: number;
  /** Live poll cadence: 2000ms in-round, 5000ms on idle screens. */
  pollMs?: number;
  showHeader?: boolean;
}

/**
 * The exact live YES-probability tape ($0.01–$0.99) ticking on the dreamDEX
 * Central Limit Order Book for the arena in play — the same venue series every
 * round is judged against. Real fills only (scoped to the pinned window), with
 * the current top-of-book mid as the live edge and the Second-5 lock as the
 * dashed entry line. Replaces external spot charts so players decide on the
 * series that actually scores them.
 */
export function ProbabilityChart({ matchId, asset = "BTC", height = 220, pollMs = 2000, showHeader = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const entryLineRef = useRef<{ price: number; handle: unknown } | null>(null);
  const everConnectedRef = useRef(false);
  const [price, setPrice] = useState<number | null>(null);
  const [entry, setEntry] = useState<number | null>(null);
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const query = matchId
    ? `/api/matches/ec-tape?matchId=${encodeURIComponent(matchId)}`
    : `/api/matches/ec-tape?asset=${encodeURIComponent(asset)}`;

  useEffect(() => {
    let disposed = false;
    const el = containerRef.current;
    if (!el) return;
    el.innerHTML = "";

    const chart = createChart(el, {
      width: el.clientWidth > 0 ? el.clientWidth : 320,
      height,
      layout: { background: { color: "#0b1120" }, textColor: "#94a3b8" },
      grid: { vertLines: { color: "#1e293b" }, horzLines: { color: "#1e293b" } },
      timeScale: { borderColor: "#1e293b", timeVisible: true, secondsVisible: true },
      rightPriceScale: { borderColor: "#1e293b" },
      crosshair: { mode: 0 },
    });
    const series = chart.addLineSeries({
      color: "#38bdf8",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const applyTape = (data: TapeResponse) => {
      if (disposed) return;
      const byTime = new Map<number, number>();
      for (const pt of data.points ?? []) {
        if (Number.isFinite(pt.t) && Number.isFinite(pt.p)) byTime.set(pt.t, pt.p);
      }
      if (data.edge && Number.isFinite(data.edge.t) && Number.isFinite(data.edge.p)) {
        byTime.set(data.edge.t, data.edge.p);
      }
      const rows = [...byTime.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
      if (rows.length === 0) {
        setErr(data.reason === "no-arena" ? "No live window — chart paused." : "Waiting for window trades — line ticks live.");
        return;
      }
      series.setData(rows);
      chart.timeScale().scrollToRealTime();
      const last = rows[rows.length - 1].value;
      setPrice(last);
      setConnected(true);
      everConnectedRef.current = true;
      setErr(null);

      const entryPrice = typeof data.entry === "number" && data.entry > 0 ? data.entry : null;
      setEntry(entryPrice);
      if (entryPrice != null) {
        setDir(last > entryPrice ? "up" : last < entryPrice ? "down" : null);
        const prev = entryLineRef.current;
        if (!prev || Math.abs(prev.price - entryPrice) > 1e-12) {
          if (prev) {
            try { series.removePriceLine(prev.handle as never); } catch { /* stale handle */ }
          }
          const handle = series.createPriceLine({
            price: entryPrice,
            color: "#fbbf24",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "ENTRY",
          });
          entryLineRef.current = { price: entryPrice, handle };
        }
      } else {
        setDir(null);
      }
    };

    let inFlight = false;
    const load = async () => {
      if (disposed || document.hidden || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(query, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`tape ${res.status}`);
        applyTape((await res.json()) as TapeResponse);
      } catch {
        // transient — keep last chart state; surface only if never connected
        if (!disposed && !everConnectedRef.current) setErr("Live tape unavailable — retrying.");
      } finally {
        inFlight = false;
      }
    };

    load();
    const iv = setInterval(load, Math.max(1000, pollMs));
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVis);
    const onResize = () => {
      if (el.clientWidth > 0) chart.applyOptions({ width: el.clientWidth });
    };
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("resize", onResize);
      chartRef.current = null;
      seriesRef.current = null;
      entryLineRef.current = null;
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, height, pollMs]);

  const arrow = dir === "up" ? "\u2191" : dir === "down" ? "\u2193" : "\u2013";
  const arrowColor = dir === "up" ? "#10b981" : dir === "down" ? "#ef4444" : "#64748b";

  return (
    <div style={{ width: "100%" }}>
      {showHeader && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", color: "#94a3b8" }}>
            YES {"\u00B7"} EC ORDER BOOK
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10, letterSpacing: "0.08em", color: connected ? "#10b981" : "#64748b" }}>
              {connected ? "LIVE" : "CONNECTING"}
            </span>
            <span style={{ fontSize: 16, fontWeight: 900, color: arrowColor }}>{arrow}</span>
            {price !== null && (
              <span style={{ fontSize: 15, fontWeight: 900, color: "#e2e8f0", fontFamily: "'Courier New', monospace" }}>
                ${price.toFixed(4)}
              </span>
            )}
            {entry !== null && (
              <span style={{ fontSize: 10, color: "#fbbf24", letterSpacing: "0.06em" }}>
                ENTRY ${entry.toFixed(4)}
              </span>
            )}
          </span>
        </div>
      )}
      <div style={{
        position: "relative", borderRadius: 8, overflow: "hidden",
        border: "1px solid #1e293b", background: "#0b1120",
      }}>
        <div ref={containerRef} style={{ width: "100%", height }} />
        {err && (
          <div style={{ position: "absolute", bottom: 8, left: 0, right: 0, textAlign: "center", fontSize: 10, color: "#f59e0b", letterSpacing: "0.05em" }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
