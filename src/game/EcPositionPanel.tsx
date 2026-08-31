import { useEcPosition, type EcPosition } from "./useEcPosition";

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const DIR_STYLE: Record<string, { label: string; color: string }> = {
  UP: { label: "UP", color: "#10b981" },
  DOWN: { label: "DOWN", color: "#ef4444" },
  FLAT: { label: "FLAT", color: "#f59e0b" },
};

export function EcPositionRow({ pos, compact }: { pos: EcPosition | null; compact?: boolean }) {
  if (!pos) {
    return (
      <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.08em", padding: "8px 0" }}>
        {"\u23F1"} EC WINDOW {"\u2014"} checking live price...
      </div>
    );
  }
  if (!pos.live) {
    return (
      <div style={{ fontSize: 11, color: "#f59e0b", letterSpacing: "0.08em", padding: "8px 0" }}>
        {"\u23F1"} EC WINDOW {"\u2014"} between windows, no live market right now.
      </div>
    );
  }
  const dir = DIR_STYLE[pos.direction ? pos.direction : "FLAT"];
  return (
    <div style={{ fontSize: 11, lineHeight: 1.6, padding: "8px 0" }}>
      <div style={{ letterSpacing: "0.08em", color: "#64748b", fontWeight: 800, marginBottom: 4 }}>
        {"\u23F1"} EC WINDOW {"\u00B7"} {pos.asset} {"\u00B7"} {"\u23F0"} {mmss(pos.remainingSec)} left
      </div>
      {!compact && (
        <div style={{ color: "#94a3b8", display: "flex", justifyContent: "space-between", maxWidth: 340 }}>
          <span>YES: <span style={{ color: "#38bdf8", fontFamily: "'Courier New', monospace" }}>{(pos.yesPrice ?? 0).toFixed(4)}</span></span>
          <span>OPEN: <span style={{ fontFamily: "'Courier New', monospace" }}>{(pos.arenaOpen ?? 0).toFixed(4)}</span></span>
          <span>
            DIR: <span style={{ color: dir.color, fontWeight: 800 }}>{dir.label}</span>
          </span>
        </div>
      )}
      <div style={{ color: "#64748b", marginTop: compact ? 4 : 8 }}>
        Round outcomes track this window. P&amp;L locks in when it settles on-chain.
      </div>
    </div>
  );
}

export function EcPositionPanel({ matchId, compact, pollMs }: {
  matchId?: string | null;
  compact?: boolean;
  pollMs?: number;
}) {
  const { pos } = useEcPosition(matchId, pollMs ?? 4000);

  return (
    <div style={{
      width: "100%", maxWidth: compact ? 340 : 460,
      margin: compact ? "0 auto" : "0 auto 16px",
      padding: "8px 14px",
      border: "1px dashed #7c3aed", borderRadius: 8,
      background: "rgba(124,58,237,0.05)",
    }}>
      <EcPositionRow pos={pos} compact={compact} />
    </div>
  );
}
