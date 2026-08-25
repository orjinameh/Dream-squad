"use client";

import { useEffect, useState } from "react";

interface Props {
  closesAt: string; // ISO string
  onExpired?: () => void;
  size?: "lg" | "sm";
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

export function CountdownTimer({ closesAt, onExpired, size = "lg" }: Props) {
  const [remaining, setRemaining] = useState(() => new Date(closesAt).getTime() - Date.now());

  useEffect(() => {
    const tick = () => {
      const r = new Date(closesAt).getTime() - Date.now();
      setRemaining(r);
      if (r <= 0) onExpired?.();
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [closesAt, onExpired]);

  const urgent = remaining > 0 && remaining < 30_000;
  const fontSize = size === "lg" ? 48 : 24;

  return (
    <span
      style={{
        fontFamily: "monospace",
        fontSize,
        fontWeight: 700,
        color: remaining <= 0 ? "#888" : urgent ? "#ff4444" : "#00d4ff",
        letterSpacing: "0.04em",
      }}
    >
      {formatRemaining(remaining)}
    </span>
  );
}
