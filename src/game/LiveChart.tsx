"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type CandlestickData,
} from "lightweight-charts";

// DreamDEX on-chain price feed (read-only GraphQL over Somnia's price oracle).
// No external API key. Serves spot + EMA marks + M1/H1/D1 OHLC candles per
// asset; values are 1e18-scaled strings. See @somnia-chain/markets-sdk.
const FEED_URL = "https://price-feed.dev.oracle.somnia.host/v1/graphql";
const FEED_QUOTE = "USDC";
const SCALE = 10 ** 18;

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface Props {
  asset: string;
  height?: number;
  /** Render a live price readout + direction chip above the chart. */
  showHeader?: boolean;
}

function symbolFor(asset: string): string {
  return asset.toUpperCase() === "ETH" ? "ETHUSDT" : "BTCUSDT";
}

async function graphql(query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch(FEED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`DreamDEX feed ${res.status}`);
  const json = await res.json();
  if (json?.errors?.length) throw new Error(`DreamDEX feed ${json.errors[0].message}`);
  return json.data;
}

/** Latest spot price (human units) for an asset from the Feed catalog row. */
async function fetchSpot(base: string): Promise<number> {
  const data = await graphql(
    `query Feed($base: String!, $quote: String!) {
      Feed(where: { base: { _eq: $base }, quote: { _eq: $quote } }) {
        base quote latestSpot decimals
      }
    }`,
    { base, quote: FEED_QUOTE },
  );
  const feed = data?.Feed?.[0];
  if (!feed) throw new Error("no feed row");
  const decimals = feed.decimals ?? 18;
  return Number(feed.latestSpot) / 10 ** decimals;
}

/** Latest M1 OHLC candles, oldest-first (chart-ready). */
async function fetchCandles(base: string, limit = 90): Promise<Candle[]> {
  const data = await graphql(
    `query Candles($base: String!, $quote: String!, $limit: Int!) {
      Candle(
        where: { _and: [
          { base: { _eq: $base } },
          { quote: { _eq: $quote } },
          { resolution: { _eq: M1 } }
        ] }
        order_by: { bucketStart: desc }
        limit: $limit
      ) { bucketStart open high low close }
    }`,
    { base, quote: FEED_QUOTE, limit },
  );
  const rows = data?.Candle ?? [];
  return rows
    .slice()
    .reverse()
    .map((c: any) => ({
      time: Number(c.bucketStart) * 1000,
      open: Number(c.open) / SCALE,
      high: Number(c.high) / SCALE,
      low: Number(c.low) / SCALE,
      close: Number(c.close) / SCALE,
    }));
}

// Clone the last closed candle so we can edit its close/last for the live tick
// without mutating chart history while a new candle is still forming.
function buildPlaceholder(prev: Candle | null | undefined, price?: number): Candle {
  if (prev) {
    return { ...prev, high: Math.max(prev.high, price ?? prev.close), low: Math.min(prev.low, price ?? prev.close), close: price ?? prev.close };
  }
  return { time: Math.floor(Date.now() / 1000), open: price ?? 0, high: price ?? 0, low: price ?? 0, close: price ?? 0 };
}

const GAP_MS = 10_000;
const LIVE_EDGE_MS = 65_000;

export function LiveChart({ asset, height = 260, showHeader = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastCandleRef = useRef<Candle | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const base = asset.toUpperCase() === "ETH" ? "ETH" : "BTC";
  const symbol = symbolFor(asset);

  useEffect(() => {
    let disposed = false;
    const el = containerRef.current;
    if (!el) return;
    el.innerHTML = "";

    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: { background: { color: "#0b1120" }, textColor: "#94a3b8" },
      grid: { vertLines: { color: "#1e293b" }, horzLines: { color: "#1e293b" } },
      timeScale: { borderColor: "#1e293b", timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: "#1e293b" },
      crosshair: { mode: 0 },
    });
    const series = chart.addCandlestickSeries({
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const applyCandles = (candles: Candle[]) => {
      if (disposed) return;
      const data: CandlestickData[] = candles.map((c) => ({
        time: (c.time / 1000) as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      series.setData(data);
      lastCandleRef.current = candles[candles.length - 1] ?? null;
      if (lastCandleRef.current) {
        setPrice(lastCandleRef.current.close);
        setDir(null);
      }
    };

    // Pull initial candles + current spot from the DreamDEX oracle.
    Promise.all([fetchCandles(base), fetchSpot(base)])
      .then(([candles, spot]) => {
        if (disposed) return;
        applyCandles(candles);
        if (lastCandleRef.current) {
          const last = lastCandleRef.current;
          const live = { ...last, high: Math.max(last.high, spot), low: Math.min(last.low, spot), close: spot };
          lastCandleRef.current = live;
          series.update(live as CandlestickData);
        }
        setPrice(spot);
        setConnected(true);
        setErr(null);
      })
      .catch((e) => {
        if (!disposed) setErr("Live feed unavailable — chart paused.");
      });

    // Live edge: refresh the current spot and fold it into the forming candle.
    const poll = setInterval(async () => {
      if (disposed) return;
      try {
        const spot = await fetchSpot(base);
        if (disposed) return;
        setPrice(spot);
        const prev = lastCandleRef.current;
        if (prev) {
          const prevClose = prev.close;
          const live: Candle = {
            ...prev,
            time: prev.time,
            high: Math.max(prev.high, spot),
            low: Math.min(prev.low, spot),
            close: spot,
          };
          lastCandleRef.current = live;
          setDir(spot >= prevClose ? "up" : "down");
          series.update(live as CandlestickData);
          setConnected(true);
        }
      } catch {
        // transient — keep last chart state
      }
    }, GAP_MS);

    const onResize = () => { chart.applyOptions({ width: el.clientWidth }); };
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      clearInterval(poll);
      window.removeEventListener("resize", onResize);
      chartRef.current = null;
      seriesRef.current = null;
      chart.remove();
    };
  }, [base, height]);

  const decimals = symbol === "ETHUSDT" ? 2 : 0;
  const arrow = dir === "up" ? "\u2191" : dir === "down" ? "\u2193" : "\u2013";
  const arrowColor = dir === "up" ? "#10b981" : dir === "down" ? "#ef4444" : "#64748b";

  return (
    <div style={{ width: "100%" }}>
      {showHeader && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", color: "#94a3b8" }}>
            {symbol} {"\u00B7"} tUSDC SETTLEMENT
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10, letterSpacing: "0.08em", color: connected ? "#10b981" : "#64748b" }}>
              {connected ? "LIVE" : "CONNECTING"}
            </span>
            <span style={{ fontSize: 16, fontWeight: 900, color: arrowColor }}>{arrow}</span>
            {price !== null && (
              <span style={{ fontSize: 15, fontWeight: 900, color: "#e2e8f0", fontFamily: "'Courier New', monospace" }}>
                {price.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
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
