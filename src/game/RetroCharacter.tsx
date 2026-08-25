"use client";

import { type CharacterDef } from "./characters";

interface Props {
  char: CharacterDef;
  state?: "idle" | "thinking" | "locked" | "attack" | "hit" | "victory" | "defeat";
  flip?: boolean;
  size?: number;
  aura?: string;
}

export function RetroCharacter({ char, state = "idle", flip = false, size = 1, aura }: Props) {
  const c = char.colors;
  const s = (px: number) => px * size;
  const sx = (px: number) => px * size;

  const animName =
    state === "idle" ? "charIdle" :
    state === "thinking" ? "charThink" :
    state === "locked" ? "charLocked" :
    state === "attack" ? "charAttack" :
    state === "hit" ? "charHit" :
    state === "victory" ? "charVictory" :
    state === "defeat" ? "charDefeat" : "charIdle";

  return (
    <div style={{
      position: "relative",
      width: sx(80), height: sx(110),
      transform: flip ? "scaleX(-1)" : "none",
      filter: aura ? `drop-shadow(0 0 ${8 * size}px ${aura})` : undefined,
      animation: `${animName} 0.6s steps(4) infinite`,
    }}>
      {/* Head */}
      <div style={{
        position: "absolute", top: 0, left: sx(14), width: sx(52), height: sx(44),
        borderRadius: `${s(20)}px ${s(20)}px ${s(14)}px ${s(14)}px`,
        background: `linear-gradient(135deg, ${c.skin}, ${darken(c.skin, 30)})`,
        border: `${Math.max(2, s(2))}px solid ${c.hair}`,
        boxShadow: `inset ${s(3)}px ${s(3)}px 0 ${darken(c.skin, 20)}`,
      }}>
        {/* Eyes */}
        <div style={{
          position: "absolute", top: sx(16), left: sx(10),
          width: sx(8), height: sx(10), borderRadius: "50%",
          background: "#fff", border: `${Math.max(1, s(1))}px solid #222`,
        }}>
          <div style={{
            position: "absolute", top: sx(2), left: state === "thinking" ? sx(1) : sx(2),
            width: sx(4), height: sx(5), borderRadius: "50%", background: "#111",
          }} />
        </div>
        <div style={{
          position: "absolute", top: sx(16), right: sx(10),
          width: sx(8), height: sx(10), borderRadius: "50%",
          background: "#fff", border: `${Math.max(1, s(1))}px solid #222`,
        }}>
          <div style={{
            position: "absolute", top: sx(2), left: state === "thinking" ? sx(1) : sx(2),
            width: sx(4), height: sx(5), borderRadius: "50%", background: "#111",
          }} />
        </div>
        {/* Mouth */}
        <div style={{
          position: "absolute", bottom: sx(6), left: "50%", transform: "translateX(-50%)",
          width: sx(14), height: state === "victory" ? sx(6) : sx(3),
          borderRadius: state === "victory" ? `0 0 ${s(8)}px ${s(8)}px` : s(2),
          background: state === "hit" ? c.accent : state === "victory" ? "#c0392b" : "#5a3a2a",
          border: `${Math.max(1, s(1))}px solid ${darken(c.skin, 40)}`,
        }} />
      </div>

      {/* Hair / Hat */}
      <div style={{
        position: "absolute", top: sx(-2), left: sx(10), width: sx(60), height: sx(18),
        borderRadius: `${s(16)}px ${s(16)}px 0 0`,
        background: c.hair,
        boxShadow: `inset ${s(2)}px ${s(2)}px 0 ${lighten(c.hair, 20)}`,
      }} />

      {/* Body / Torso */}
      <div style={{
        position: "absolute", top: sx(42), left: sx(16), width: sx(48), height: sx(36),
        borderRadius: `${s(6)}px ${s(6)}px ${s(10)}px ${s(10)}px`,
        background: `linear-gradient(180deg, ${c.outfit}, ${darken(c.outfit, 15)})`,
        border: `${Math.max(2, s(2))}px solid ${darken(c.outfit, 30)}`,
        boxShadow: `inset ${s(4)}px 0 0 ${lighten(c.outfit, 10)}`,
      }}>
        {/* Belt / Accent */}
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0, height: sx(8),
          background: c.accent,
          borderRadius: `0 0 ${s(4)}px ${s(4)}px`,
        }} />
      </div>

      {/* Left Arm */}
      <div style={{
        position: "absolute", top: sx(44), left: sx(4),
        width: sx(14), height: sx(28),
        borderRadius: `${s(8)}px ${s(4)}px ${s(6)}px ${s(6)}px`,
        background: `linear-gradient(135deg, ${c.skin}, ${darken(c.skin, 20)})`,
        border: `${Math.max(1, s(1))}px solid ${darken(c.skin, 30)}`,
        transformOrigin: "top center",
        animation: state === "attack" ? "charArmAttack 0.3s steps(3) infinite" : undefined,
      }}>
        {/* Fist */}
        <div style={{
          position: "absolute", bottom: sx(-4), left: sx(1),
          width: sx(12), height: sx(10), borderRadius: s(5),
          background: c.skin, border: `${Math.max(1, s(1))}px solid ${darken(c.skin, 30)}`,
        }} />
      </div>

      {/* Right Arm */}
      <div style={{
        position: "absolute", top: sx(44), right: sx(4),
        width: sx(14), height: sx(28),
        borderRadius: `${s(4)}px ${s(8)}px ${s(6)}px ${s(6)}px`,
        background: `linear-gradient(135deg, ${c.skin}, ${darken(c.skin, 20)})`,
        border: `${Math.max(1, s(1))}px solid ${darken(c.skin, 30)}`,
        transformOrigin: "top center",
      }}>
        <div style={{
          position: "absolute", bottom: sx(-4), right: sx(1),
          width: sx(12), height: sx(10), borderRadius: s(5),
          background: c.skin, border: `${Math.max(1, s(1))}px solid ${darken(c.skin, 30)}`,
        }} />
      </div>

      {/* Left Leg */}
      <div style={{
        position: "absolute", top: sx(76), left: sx(18),
        width: sx(18), height: sx(20),
        borderRadius: `${s(4)}px ${s(4)}px ${s(2)}px ${s(2)}px`,
        background: `linear-gradient(180deg, ${darken(c.outfit, 10)}, ${darken(c.outfit, 25)})`,
        border: `${Math.max(1, s(1))}px solid ${darken(c.outfit, 35)}`,
      }}>
        <div style={{
          position: "absolute", bottom: 0, left: sx(-2), width: sx(22), height: sx(10),
          borderRadius: `${s(2)}px ${s(6)}px ${s(2)}px ${s(2)}px`,
          background: c.boot,
          border: `${Math.max(1, s(1))}px solid ${darken(c.boot, 20)}`,
        }} />
      </div>

      {/* Right Leg */}
      <div style={{
        position: "absolute", top: sx(76), right: sx(18),
        width: sx(18), height: sx(20),
        borderRadius: `${s(4)}px ${s(4)}px ${s(2)}px ${s(2)}px`,
        background: `linear-gradient(180deg, ${darken(c.outfit, 10)}, ${darken(c.outfit, 25)})`,
        border: `${Math.max(1, s(1))}px solid ${darken(c.outfit, 35)}`,
      }}>
        <div style={{
          position: "absolute", bottom: 0, right: sx(-2), width: sx(22), height: sx(10),
          borderRadius: `${s(6)}px ${s(2)}px ${s(2)}px ${s(2)}px`,
          background: c.boot,
          border: `${Math.max(1, s(1))}px solid ${darken(c.boot, 20)}`,
        }} />
      </div>

      <style>{`
        @keyframes charIdle {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
        @keyframes charThink {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          25% { transform: translateY(-2px) rotate(-1deg); }
          75% { transform: translateY(-1px) rotate(1deg); }
        }
        @keyframes charLocked {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.05); }
        }
        @keyframes charAttack {
          0% { transform: translateX(0) rotate(0deg); }
          33% { transform: translateX(15px) rotate(-5deg); }
          66% { transform: translateX(-5px) rotate(2deg); }
          100% { transform: translateX(0) rotate(0deg); }
        }
        @keyframes charHit {
          0%, 100% { transform: translateX(0); filter: brightness(1); }
          20% { transform: translateX(-10px); filter: brightness(2); }
          40% { transform: translateX(8px); filter: brightness(0.8); }
          60% { transform: translateX(-4px); filter: brightness(1.2); }
          80% { transform: translateX(2px); filter: brightness(1); }
        }
        @keyframes charVictory {
          0%, 100% { transform: translateY(0) scale(1); }
          25% { transform: translateY(-8px) scale(1.05); }
          50% { transform: translateY(-4px) scale(1.02); }
          75% { transform: translateY(-10px) scale(1.08); }
        }
        @keyframes charDefeat {
          0%, 100% { transform: translateY(0) rotate(0deg); opacity: 1; }
          50% { transform: translateY(4px) rotate(5deg); opacity: 0.7; }
        }
        @keyframes charArmAttack {
          0% { transform: rotate(0deg); }
          50% { transform: rotate(-45deg); }
          100% { transform: rotate(0deg); }
        }
      `}</style>
    </div>
  );
}

function darken(hex: string, pct: number): string {
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - pct);
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - pct);
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - pct);
  return `rgb(${r},${g},${b})`;
}

function lighten(hex: string, pct: number): string {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + pct);
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + pct);
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + pct);
  return `rgb(${r},${g},${b})`;
}
