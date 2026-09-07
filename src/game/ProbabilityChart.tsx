"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

export interface TickPoint {
  t: number; // unix seconds
  p: number; // YES probability in [0.01, 0.99]
  v: number; // tUSDC value traded (0 for live-edge polls)
}

interface TapeResponse {
  asset: string;
  marketId: string | null;
  symbol: string | null;
  live: boolean;
  reason?: string;
  points: TickPoint[];
  edge: TickPoint | null;
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
  /** Candle bucket in seconds. ~3 candles per 15s battle + window history. */
  bucketSec?: number;
}

export interface CandleRow {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface VolumeRow {
  time: UTCTimestamp;
  value: number;
  color: string;
}

const UP = "#10b981";
const DOWN = "#ef4444";
const VOL_UP = "rgba(16,185,129,0.45)";
const VOL_DOWN = "rgba(239,68,68,0.45)";

/**
 * Bucket sparse fill ticks into fixed time candles. Empty buckets are omitted
 * (never fabricated); single-tick buckets render as honest flat dojis; the
 * live edge rolls the forming bucket without adding volume.
 */
export function bucketCandles(
  points: TickPoint[],
  edge: TickPoint | null,
  bucketSec = 5,
): { candles: CandleRow[]; volumes: VolumeRow[] } {
  const ticks = [...points];
  if (edge && Number.isFinite(edge.t) && Number.isFinite(edge.p)) ticks.push(edge);
  const buckets = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>();
  for (const tick of ticks) {
    if (!Number.isFinite(tick.t) || !Number.isFinite(tick.p)) continue;
    const key = Math.floor(tick.t / bucketSec) * bucketSec;
    const b = buckets.get(key);
    if (!b) {
      buckets.set(key, { open: tick.p, high: tick.p, low: tick.p, close: tick.p, volume: tick.v > 0 ? tick.v : 0 });
    } else {
      b.high = Math.max(b.high, tick.p);
      b.low = Math.min(b.low, tick.p);
      b.close = tick.p;
      if (tick.v > 0) b.volume += tick.v;
    }
  }
  const candles: CandleRow[] = [];
  const volumes: VolumeRow[] = [];
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    const b = buckets.get(key)!;
    const time = key as UTCTimestamp;
    candles.push({ time, open: b.open, high: b.high, low: b.low, close: b.close });
    volumes.push({ time, value: b.volume, color: b.close >= b.open ? VOL_UP : VOL_DOWN });
  }
  return { candles, volumes };
}

/**
 * The exact live YES-probability tape ($0.01–$0.99) ticking on the dreamDEX
 * Central Limit Order Book for the arena in play — rendered as candlesticks
 * with real traded volume, the same venue series every round is judged
 * against. Replaces external spot charts so players decide on the series that
 * actually scores them.
 */
export function ProbabilityChart({ matchId, asset = "BTC", height = 220, pollMs = 2000, showHeader = true, bucketSec = 5 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
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
      // Supported at runtime (v4.2.3 honors it); absent from the bundled
      // typings, hence the narrow assertion.
      attributionLogo: false,
      layout: { background: { color: "#0b1120" }, textColor: "#94a3b8" },
      grid: { vertLines: { color: "#1e293b" }, horzLines: { color: "#1e293b" } },
      timeScale: { borderColor: "#1e293b", timeVisible: true, secondsVisible: true },
      rightPriceScale: { borderColor: "#1e293b" },
      crosshair: { mode: 0 },
    } as Parameters<typeof createChart>[1]);
    const candles = chart.addCandlestickSeries({
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
    });
    const volumes = chart.addHistogramSeries({
      priceScaleId: "",
      priceFormat: { type: "volume" },
    });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = chart;
    candleRef.current = candles;
    volRef.current = volumes;

    const applyTape = (data: TapeResponse) => {
      if (disposed) return;
      const { candles: rows, volumes: vols } = bucketCandles(data.points ?? [], data.edge, bucketSec);
      if (rows.length === 0) {
        setErr(data.live === false ? "No live window — chart paused." : "Waiting for window trades — candles form live.");
        return;
      }
      candles.setData(rows);
      volRef.current?.setData(vols);
      chart.timeScale().scrollToRealTime();
      const last = rows[rows.length - 1].close;
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
            try { candles.removePriceLine(prev.handle as never); } catch { /* stale handle */ }
          }
          const handle = candles.createPriceLine({
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
      candleRef.current = null;
      volRef.current = null;
      entryLineRef.current = null;
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, height, pollMs, bucketSec]);

  const arrow = dir === "up" ? "\u2191" : dir === "down" ? "\u2193" : "\u2013";
  const arrowColor = dir === "up" ? UP : dir === "down" ? DOWN : "#64748b";

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
