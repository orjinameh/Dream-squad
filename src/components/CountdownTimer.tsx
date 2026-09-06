"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  closesAt: string; // ISO string
  onExpired?: () => void;
  size?: "lg" | "sm";
}

function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

export function CountdownTimer({ closesAt, onExpired, size = "lg" }: Props) {
  const [remaining, setRemaining] = useState(() => new Date(closesAt).getTime() - Date.now());
  const firedRef = useRef(false);
  const cbRef = useRef(onExpired);
  cbRef.current = onExpired;

  useEffect(() => {
    firedRef.current = false;
    const tick = () => {
      const t = new Date(closesAt).getTime();
      const r = Number.isFinite(t) ? t - Date.now() : NaN;
      setRemaining(r);
      if (Number.isFinite(r) && r <= 0 && !firedRef.current) {
        firedRef.current = true;
        cbRef.current?.();
      }
      if (Number.isFinite(r) && r <= 0) {
        // Stop ticking once expired — firing every 250ms spams APIs.
        clearInterval(id);
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [closesAt]);

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
