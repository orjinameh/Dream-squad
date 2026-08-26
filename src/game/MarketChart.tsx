"use client";

import { useState, useEffect, useRef } from "react";

interface Props {
  asset: string;
  question: string;
  roundActive: boolean;
  roundDeadline: number;
  size?: "compact" | "full";
}

export function MarketChart({ asset, question, roundActive, roundDeadline, size = "compact" }: Props) {
  const [prices, setPrices] = useState<number[]>([]);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [startPrice, setStartPrice] = useState(0);
  const [trend, setTrend] = useState<"up" | "down" | "flat">("flat");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const base = asset === "BTC" ? 67420 : asset === "ETH" ? 3520 : asset === "SOMI" ? 0.10 : 100;
    setStartPrice(base);
    setCurrentPrice(base);
    setPrices([base]);
  }, [asset]);

  useEffect(() => {
    if (!roundActive) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      return;
    }

    intervalRef.current = setInterval(() => {
      setCurrentPrice((prev) => {
        const volatility = asset === "BTC" ? 0.002 : asset === "ETH" ? 0.003 : 0.005;
        const change = (Math.random() - 0.48) * prev * volatility;
        const next = +(prev + change).toFixed(asset === "SOMI" ? 4 : 2);
        setPrices((p) => [...p.slice(-29), next]);
        setTrend(next > startPrice ? "up" : next < startPrice ? "down" : "flat");
        return next;
      });
    }, 800);

    return () => { if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; } };
  }, [roundActive, asset, startPrice]);

  const isCompact = size === "compact";
  const priceChange = currentPrice - startPrice;
  const pctChange = startPrice > 0 ? ((priceChange / startPrice) * 100) : 0;
  const arrow = trend === "up" ? "\u2191" : trend === "down" ? "\u2193" : "\u2192";
  const arrowColor = trend === "up" ? "#10b981" : trend === "down" ? "#ef4444" : "#64748b";

  const timeLeft = Math.max(0, (roundDeadline - Date.now()) / 1000);
  const urgency = timeLeft <= 2 ? "critical" : timeLeft <= 5 ? "urgent" : "calm";

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
          {asset}
        </span>
        <span style={{ fontSize: isCompact ? 18 : 24, fontWeight: 900, color: arrowColor, letterSpacing: "0.05em" }}>
          {arrow}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: isCompact ? 16 : 22, fontWeight: 900, color: "#e2e8f0", letterSpacing: "0.03em" }}>
          {currentPrice.toFixed(asset === "SOMI" ? 4 : 2)}
        </span>
        <span style={{
          fontSize: isCompact ? 10 : 12, fontWeight: 700,
          color: priceChange >= 0 ? "#10b981" : "#ef4444",
        }}>
          {priceChange >= 0 ? "+" : ""}{pctChange.toFixed(2)}%
        </span>
      </div>

      <MiniSparkline prices={prices} height={isCompact ? 28 : 40} color={arrowColor} />

      {roundActive && (
        <div style={{
          fontSize: isCompact ? 9 : 10,
          color: urgency === "critical" ? "#ef4444" : urgency === "urgent" ? "#f59e0b" : "#64748b",
          letterSpacing: "0.08em",
          marginTop: 4,
          textAlign: "center",
          animation: urgency === "critical" ? "criticalPulse 0.4s steps(2) infinite" : undefined,
        }}>
          {timeLeft > 0 ? `LIVE \u00B7 ${timeLeft.toFixed(1)}s` : "ROUND ENDED"}
        </div>
      )}
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
