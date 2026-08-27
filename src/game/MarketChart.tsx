"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  asset: string;
  question: string;
  roundActive: boolean;
  roundDeadline: number;
  // Server-authoritative deterministic series (matches what resolution uses).
  prices?: number[];
  startPrice?: number;
  endPrice?: number;
  size?: "compact" | "full";
}

export function MarketChart({
  asset,
  question,
  roundActive,
  roundDeadline,
  prices,
  startPrice,
  endPrice,
  size = "compact",
}: Props) {
  const [tick, setTick] = useState(0);
  const lastActiveRef = useRef(false);

  // Tick ~10x/sec while the round is live so the chart advances smoothly.
  useEffect(() => {
    if (!roundActive) {
      if (lastActiveRef.current) {
        lastActiveRef.current = false;
        setTick((t) => t + 1);
      }
      return;
    }
    lastActiveRef.current = true;
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [roundActive]);

  const series = prices && prices.length >= 2 ? prices : null;
  const base = startPrice ?? (series ? series[0] : 0);

  // Reveal the series left→right proportionally to the 10-second round.
  const visible = useMemo(() => {
    if (!roundActive) return series;
    if (!series) return series;
    const elapsedFrac = Math.min(
      1,
      Math.max(0, ((roundDeadline - 10000 - Date.now()) * -1) / 10000),
    );
    const count = Math.max(2, Math.round(elapsedFrac * series.length));
    return series.slice(0, count);
  }, [roundActive, series, roundDeadline, tick]);

  const currentPrice = visible && visible.length ? visible[visible.length - 1] : base;

  const priceChange = currentPrice - base;
  const pctChange = base > 0 ? (priceChange / base) * 100 : 0;
  const trend = priceChange > 0.0000001 ? "up" : priceChange < -0.0000001 ? "down" : "flat";
  const isCompact = size === "compact";
  const arrow = trend === "up" ? "\u2191" : trend === "down" ? "\u2193" : "\u2192";
  const arrowColor = trend === "up" ? "#10b981" : trend === "down" ? "#ef4444" : "#64748b";

  const timeLeft = Math.max(0, (roundDeadline - Date.now()) / 1000);
  const urgency = timeLeft <= 2 ? "critical" : timeLeft <= 5 ? "urgent" : "calm";
  const decimals = asset === "SOMI" ? 4 : 2;

  return (
    <div style={{
      background: "rgba(15,23,42,0.9)",
      border: "2px solid #1e293b",
      borderRadius: 8,
      padding: isCompact ? "8px 12px" : "12px 16px",
      width: isCompact ? "100%" : 320,
      maxWidth: isCompact ? 400 : 320,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: isCompact ? 11 : 13, color: "#94a3b8", letterSpacing: "0.08em", fontWeight: 700 }}>
          {asset}/USD
        </span>
        <span style={{ fontSize: isCompact ? 18 : 24, fontWeight: 900, color: arrowColor, letterSpacing: "0.05em" }}>
          {arrow}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: isCompact ? 16 : 22, fontWeight: 900, color: "#e2e8f0", letterSpacing: "0.03em" }}>
          {currentPrice ? currentPrice.toFixed(decimals) : "--"}
        </span>
        <span style={{ fontSize: isCompact ? 10 : 12, fontWeight: 700, color: priceChange >= 0 ? "#10b981" : "#ef4444" }}>
          {priceChange >= 0 ? "+" : ""}{pctChange.toFixed(2)}%
        </span>
      </div>

      <MiniSparkline prices={visible ?? []} height={isCompact ? 28 : 40} color={arrowColor} />

      <div style={{
        display: "flex", justifyContent: "space-between", marginTop: 4,
        fontSize: isCompact ? 9 : 10, color: "#64748b", letterSpacing: "0.08em",
      }}>
        <span>START: {base ? base.toFixed(decimals) : "--"}</span>
        <span style={{ color: trend === "up" ? "#10b981" : trend === "down" ? "#ef4444" : "#64748b" }}>
          {roundActive ? (timeLeft > 0 ? `LIVE \u00B7 ${timeLeft.toFixed(1)}s` : "ROUND ENDED") : endPrice ? `NOW: ${endPrice.toFixed(decimals)}` : ""}
        </span>
      </div>
    </div>
  );
}

function MiniSparkline({ prices, height, color }: { prices: number[]; height: number; color: string }) {
  if (prices.length < 2) return <div style={{ height, background: "#1e293b", borderRadius: 4 }} />;

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const width = 100;

  const points = prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * width;
    const y = height - ((p - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(" ");

  const fillPoints = `0,${height} ${points} ${width},${height}`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height, borderRadius: 4, overflow: "hidden" }}>
      <defs>
        <linearGradient id={`grad-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={fillPoints} fill={`url(#grad-${color.replace("#", "")})`} />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
