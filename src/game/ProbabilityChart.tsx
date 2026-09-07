"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

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
  /** Candle bucket in seconds. ~2 candles per 10s battle + window history. */
  bucketSec?: number;
}

export interface CandleRow {
  time: number; // bucket start, unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface VolumeRow {
  time: number;
  value: number;
  color: string;
}

const UP = "#10b981";
const DOWN = "#ef4444";
const LINE = "#38bdf8";
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
    candles.push({ time: key, open: b.open, high: b.high, low: b.low, close: b.close });
    volumes.push({ time: key, value: b.volume, color: b.close >= b.open ? VOL_UP : VOL_DOWN });
  }
  return { candles, volumes };
}

interface ChartRow {
  time: number;
  label: string;
  price: number;
  volume: number;
  up: boolean;
}

function fmtTime(t: number): string {
  const d = new Date(t * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function TapeTooltip(props: any) {
  const { active, payload, label } = props ?? {};
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as ChartRow | undefined;
  if (!row) return null;
  return (
    <div style={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px", fontSize: 11 }}>
      <div style={{ color: "#94a3b8", marginBottom: 2 }}>{label}</div>
      <div style={{ color: "#e2e8f0", fontWeight: 800, fontFamily: "'Courier New', monospace" }}>
        YES ${row.price.toFixed(4)}
      </div>
      <div style={{ color: "#64748b" }}>Vol {row.volume.toFixed(2)} tUSDC</div>
    </div>
  );
}

/**
 * The exact live YES-probability tape ($0.01–$0.99) ticking on the dreamDEX
 * Central Limit Order Book for the arena in play — rendered as a price area
 * with real traded volume underneath, the same venue series every round is
 * judged against. Replaces external spot charts so players decide on the
 * series that actually scores them. No third-party watermark: every pixel
 * below is our own SVG.
 */
export function ProbabilityChart({ matchId, asset = "BTC", height = 220, pollMs = 2000, showHeader = true, bucketSec = 5 }: Props) {
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [rows, setRows] = useState<ChartRow[]>([]);
  const [price, setPrice] = useState<number | null>(null);
  const [entry, setEntry] = useState<number | null>(null);
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const everConnectedRef = useRef(false);

  const query = matchId
    ? `/api/matches/ec-tape?matchId=${encodeURIComponent(matchId)}`
    : `/api/matches/ec-tape?asset=${encodeURIComponent(asset)}`;

  useEffect(() => {
    let disposed = false;
    let inFlight = false;

    const load = async () => {
      if (disposed || document.hidden || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(query, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`tape ${res.status}`);
        const data = (await res.json()) as TapeResponse;
        const { candles, volumes } = bucketCandles(data.points ?? [], data.edge, bucketSec);
        const volByTime = new Map(volumes.map((v) => [v.time, v]));
        const next: ChartRow[] = candles.map((c) => ({
          time: c.time,
          label: fmtTime(c.time),
          price: c.close,
          volume: volByTime.get(c.time)?.value ?? 0,
          up: c.close >= c.open,
        }));
        if (disposed) return;
        if (next.length === 0) {
          setErr(data.live === false ? "No live window — chart paused." : "Waiting for window trades — line ticks live.");
          return;
        }
        setRows(next);
        const last = next[next.length - 1].price;
        setPrice(last);
        setConnected(true);
        everConnectedRef.current = true;
        setErr(null);

        const entryPrice = typeof data.entry === "number" && data.entry > 0 ? data.entry : null;
        setEntry(entryPrice);
        setDir(entryPrice != null ? (last > entryPrice ? "up" : last < entryPrice ? "down" : null) : null);
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
    return () => {
      disposed = true;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [query, pollMs, bucketSec]);

  // Autoscale around the data so thin-book micro-moves are visible instead of
  // a flat line: pad the observed range, clamped to probability bounds.
  const domain = useMemo<[number, number]>(() => {
    if (rows.length === 0) return [0.01, 0.99];
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of rows) {
      if (r.price < lo) lo = r.price;
      if (r.price > hi) hi = r.price;
    }
    const pad = Math.max(0.005, (hi - lo) * 0.35);
    return [Math.max(0, lo - pad), Math.min(1, hi + pad)];
  }, [rows]);

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
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9, letterSpacing: "0.08em", color: "#64748b" }}>
          <span style={{ display: "inline-block", width: 14, height: 3, borderRadius: 2, background: "#38bdf8" }} />
          YES PRICE
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9, letterSpacing: "0.08em", color: "#64748b" }}>
          <span style={{ display: "inline-block", width: 14, height: 0, borderTop: "2px dashed #fbbf24" }} />
          YOUR ENTRY
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9, letterSpacing: "0.08em", color: "#64748b" }}>
          <span style={{ display: "inline-block", width: 8, height: 10, borderRadius: 1, background: "rgba(148,163,184,0.5)" }} />
          TRADED VOLUME
        </span>
      </div>
      <div style={{
        position: "relative", borderRadius: 8, overflow: "hidden",
        border: "1px solid #1e293b", background: "#0b1120",
      }}>
        <div style={{ width: "100%", height }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={`tape-${gid}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1e293b" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "#64748b", fontSize: 9 }} tickLine={false} axisLine={{ stroke: "#1e293b" }} minTickGap={40} />
              <YAxis
                domain={domain}
                tick={{ fill: "#64748b", fontSize: 9 }}
                tickLine={false}
                axisLine={false}
                width={44}
                tickFormatter={(v: number) => `$${v.toFixed(2)}`}
              />
              <YAxis yAxisId="vol" orientation="right" hide domain={[0, "dataMax"]} />
              <Tooltip content={<TapeTooltip />} />
              <Bar dataKey="volume" yAxisId="vol" barSize={10} radius={[2, 2, 0, 0]}>
                {rows.map((r) => (
                  <Cell key={r.time} fill={r.up ? VOL_UP : VOL_DOWN} />
                ))}
              </Bar>
              <Area
                type="monotone"
                dataKey="price"
                stroke="#38bdf8"
                strokeWidth={2}
                fill={`url(#tape-${gid})`}
                dot={false}
                activeDot={{ r: 3, fill: "#38bdf8" }}
              />
              {entry !== null && (
                <ReferenceLine
                  y={entry}
                  stroke="#fbbf24"
                  strokeDasharray="6 4"
                  strokeWidth={1}
                  label={{ value: `ENTRY $${entry.toFixed(4)}`, fill: "#fbbf24", fontSize: 9, position: "insideTopRight" }}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {err && (
          <div style={{ position: "absolute", bottom: 8, left: 0, right: 0, textAlign: "center", fontSize: 10, color: "#f59e0b", letterSpacing: "0.05em" }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
