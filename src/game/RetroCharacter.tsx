"use client";

import { type CharacterDef } from "./characters";
import { type FighterState } from "./types";

interface Props {
  char: CharacterDef;
  state?: FighterState;
  flip?: boolean;
  size?: number;
  aura?: string;
}

export function RetroCharacter({ char, state = "idle", flip = false, size = 1, aura }: Props) {
  const c = char.colors;
  const s = (px: number) => px * size;

  const animName =
    state === "idle" ? "charIdle" :
    state === "thinking" ? "charThink" :
    state === "locked" ? "charLocked" :
    state === "windup" ? "charWindup" :
    state === "attack" ? "charAttack" :
    state === "hit" ? "charHit" :
    state === "block" ? "charBlock" :
    state === "knockback" ? "charKnockback" :
    state === "stunned" ? "charStunned" :
    state === "victory" ? "charVictory" :
    state === "defeat" ? "charDefeat" : "charIdle";

  const isAttacking = state === "windup" || state === "attack";
  const isHit = state === "hit" || state === "knockback" || state === "stunned";
  const isClashing = state === "block";

  return (
    <div style={{
      position: "relative",
      width: s(80), height: s(110),
      transform: flip ? "scaleX(-1)" : "none",
      filter: aura ? `drop-shadow(0 0 ${8 * size}px ${aura})` : undefined,
      animation: `${animName} 0.6s steps(4) infinite`,
    }}>
      {/* Head */}
      <div style={{
        position: "absolute", top: 0, left: s(14), width: s(52), height: s(44),
        borderRadius: `${s(20)}px ${s(20)}px ${s(14)}px ${s(14)}px`,
        background: `linear-gradient(135deg, ${c.skin}, ${darken(c.skin, 30)})`,
        border: `${Math.max(2, s(2))}px solid ${c.hair}`,
        boxShadow: `inset ${s(3)}px ${s(3)}px 0 ${darken(c.skin, 20)}`,
      }}>
        {/* Eyes */}
        <div style={{
          position: "absolute", top: s(16), left: s(10),
          width: s(8), height: s(10), borderRadius: "50%",
          background: isHit ? "#ff0000" : "#fff",
          border: `${Math.max(1, s(1))}px solid #222`,
        }}>
          <div style={{
            position: "absolute", top: s(2),
            left: state === "thinking" ? s(1) : state === "stunned" ? s(-1) : s(2),
            width: s(4), height: s(5), borderRadius: "50%",
            background: state === "stunned" ? "#ff4444" : "#111",
          }} />
        </div>
        <div style={{
          position: "absolute", top: s(16), right: s(10),
          width: s(8), height: s(10), borderRadius: "50%",
          background: isHit ? "#ff0000" : "#fff",
          border: `${Math.max(1, s(1))}px solid #222`,
        }}>
          <div style={{
            position: "absolute", top: s(2),
            left: state === "thinking" ? s(1) : state === "stunned" ? s(-1) : s(2),
            width: s(4), height: s(5), borderRadius: "50%",
            background: state === "stunned" ? "#ff4444" : "#111",
          }} />
        </div>
        {/* Mouth */}
        <div style={{
          position: "absolute", bottom: s(6), left: "50%", transform: "translateX(-50%)",
          width: s(14),
          height: state === "victory" ? s(6) : state === "hit" || state === "stunned" ? s(5) : s(3),
          borderRadius: state === "victory" ? `0 0 ${s(8)}px ${s(8)}px` : s(2),
          background: isHit ? "#c0392b" : state === "victory" ? "#c0392b" : "#5a3a2a",
          border: `${Math.max(1, s(1))}px solid ${darken(c.skin, 40)}`,
        }} />
        {/* Stun stars */}
        {state === "stunned" && (
          <div style={{
            position: "absolute", top: s(-8), left: s(8), width: s(36), height: s(12),
            display: "flex", justifyContent: "space-between", animation: "stunStars 0.4s linear infinite",
          }}>
            {[0, 1, 2].map((i) => (
              <span key={i} style={{ fontSize: s(8), color: "#fbbf24", textShadow: "0 0 4px #f59e0b" }}>{'\u2605'}</span>
            ))}
          </div>
        )}
      </div>

      {/* Hair / Hat */}
      <div style={{
        position: "absolute", top: s(-2), left: s(10), width: s(60), height: s(18),
        borderRadius: `${s(16)}px ${s(16)}px 0 0`,
        background: c.hair,
        boxShadow: `inset ${s(2)}px ${s(2)}px 0 ${lighten(c.hair, 20)}`,
      }} />

      {/* Body / Torso */}
      <div style={{
        position: "absolute", top: s(42), left: s(16), width: s(48), height: s(36),
        borderRadius: `${s(6)}px ${s(6)}px ${s(10)}px ${s(10)}px`,
        background: `linear-gradient(180deg, ${c.outfit}, ${darken(c.outfit, 15)})`,
        border: `${Math.max(2, s(2))}px solid ${darken(c.outfit, 30)}`,
        boxShadow: `inset ${s(4)}px 0 0 ${lighten(c.outfit, 10)}`,
      }}>
        {/* Belt / Accent */}
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0, height: s(8),
          background: c.accent,
          borderRadius: `0 0 ${s(4)}px ${s(4)}px`,
        }} />
      </div>

      {/* Left Arm */}
      <div style={{
        position: "absolute", top: s(44), left: s(4),
        width: s(14), height: s(28),
        borderRadius: `${s(8)}px ${s(4)}px ${s(6)}px ${s(6)}px`,
        background: `linear-gradient(135deg, ${c.skin}, ${darken(c.skin, 20)})`,
        border: `${Math.max(1, s(1))}px solid ${darken(c.skin, 30)}`,
        transformOrigin: "top center",
        animation: isAttacking ? "charArmAttack 0.3s steps(3) infinite" : isClashing ? "charArmBlock 0.3s steps(2) infinite" : undefined,
      }}>
        {/* Fist */}
        <div style={{
          position: "absolute", bottom: s(-4), left: s(1),
          width: s(12), height: s(10), borderRadius: s(5),
          background: c.skin, border: `${Math.max(1, s(1))}px solid ${darken(c.skin, 30)}`,
        }} />
      </div>

      {/* Right Arm */}
      <div style={{
        position: "absolute", top: s(44), right: s(4),
        width: s(14), height: s(28),
        borderRadius: `${s(4)}px ${s(8)}px ${s(6)}px ${s(6)}px`,
        background: `linear-gradient(135deg, ${c.skin}, ${darken(c.skin, 20)})`,
        border: `${Math.max(1, s(1))}px solid ${darken(c.skin, 30)}`,
        transformOrigin: "top center",
        animation: isClashing ? "charArmBlock 0.3s steps(2) infinite" : undefined,
      }}>
        <div style={{
          position: "absolute", bottom: s(-4), right: s(1),
          width: s(12), height: s(10), borderRadius: s(5),
          background: c.skin, border: `${Math.max(1, s(1))}px solid ${darken(c.skin, 30)}`,
        }} />
      </div>

      {/* Left Leg */}
      <div style={{
        position: "absolute", top: s(76), left: s(18),
        width: s(18), height: s(20),
        borderRadius: `${s(4)}px ${s(4)}px ${s(2)}px ${s(2)}px`,
        background: `linear-gradient(180deg, ${darken(c.outfit, 10)}, ${darken(c.outfit, 25)})`,
        border: `${Math.max(1, s(1))}px solid ${darken(c.outfit, 35)}`,
      }}>
        <div style={{
          position: "absolute", bottom: 0, left: s(-2), width: s(22), height: s(10),
          borderRadius: `${s(2)}px ${s(6)}px ${s(2)}px ${s(2)}px`,
          background: c.boot,
          border: `${Math.max(1, s(1))}px solid ${darken(c.boot, 20)}`,
        }} />
      </div>

      {/* Right Leg */}
      <div style={{
        position: "absolute", top: s(76), right: s(18),
        width: s(18), height: s(20),
        borderRadius: `${s(4)}px ${s(4)}px ${s(2)}px ${s(2)}px`,
        background: `linear-gradient(180deg, ${darken(c.outfit, 10)}, ${darken(c.outfit, 25)})`,
        border: `${Math.max(1, s(1))}px solid ${darken(c.outfit, 35)}`,
      }}>
        <div style={{
          position: "absolute", bottom: 0, right: s(-2), width: s(22), height: s(10),
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
        @keyframes charWindup {
          0%, 100% { transform: translateX(0) rotate(0deg) scale(1); }
          50% { transform: translateX(-8px) rotate(5deg) scale(1.08); }
        }
        @keyframes charAttack {
          0% { transform: translateX(0) rotate(0deg); }
          30% { transform: translateX(20px) rotate(-8deg); }
          60% { transform: translateX(10px) rotate(-3deg); }
          100% { transform: translateX(0) rotate(0deg); }
        }
        @keyframes charHit {
          0%, 100% { transform: translateX(0); filter: brightness(1); }
          15% { transform: translateX(-12px); filter: brightness(2.5); }
          30% { transform: translateX(10px); filter: brightness(0.7); }
          45% { transform: translateX(-6px); filter: brightness(1.3); }
          60% { transform: translateX(3px); filter: brightness(1); }
        }
        @keyframes charBlock {
          0%, 100% { transform: translateX(0) scale(1); }
          50% { transform: translateX(3px) scale(1.02); }
        }
        @keyframes charKnockback {
          0% { transform: translateX(0); filter: brightness(1); }
          20% { transform: translateX(-18px) rotate(-5deg); filter: brightness(1.5); }
          50% { transform: translateX(-10px) rotate(-2deg); filter: brightness(1); }
          80% { transform: translateX(-3px); }
          100% { transform: translateX(0); filter: brightness(1); }
        }
        @keyframes charStunned {
          0%, 100% { transform: translateX(0) translateY(0); filter: brightness(1); }
          10% { transform: translateX(-4px) translateY(-1px); filter: brightness(1.5); }
          20% { transform: translateX(4px) translateY(1px); filter: brightness(0.8); }
          30% { transform: translateX(-3px); filter: brightness(1.2); }
          40% { transform: translateX(3px); filter: brightness(1); }
          50% { transform: translateX(-2px); filter: brightness(1.3); }
          60% { transform: translateX(2px); filter: brightness(0.9); }
          70% { transform: translateX(-1px); filter: brightness(1.1); }
          80% { transform: translateX(1px); filter: brightness(1); }
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
          50% { transform: rotate(-55deg); }
          100% { transform: rotate(0deg); }
        }
        @keyframes charArmBlock {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(-20deg); }
        }
        @keyframes stunStars {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

interface FlameBallProps {
  fromLeft: boolean;
  color: string;
  size?: number;
  active: boolean;
}

export function FlameBall({ fromLeft, color, size = 1, active }: FlameBallProps) {
  if (!active) return null;
  
  const s = (px: number) => px * size;
  
  return (
    <div style={{
      position: "absolute",
      top: "50%",
      left: fromLeft ? "8%" : "auto",
      right: fromLeft ? "auto" : "8%",
      transform: "translateY(-50%)",
      zIndex: 20,
      animation: fromLeft ? "flameBallRight 0.4s ease-out forwards" : "flameBallLeft 0.4s ease-out forwards",
    }}>
      {/* Outer glow */}
      <div style={{
        width: s(24), height: s(24),
        borderRadius: "50%",
        background: `radial-gradient(circle at 40% 40%, ${color}, ${color}80, transparent)`,
        boxShadow: `0 0 ${s(20)}px ${color}80, 0 0 ${s(40)}px ${color}40`,
        animation: "flamePulse 0.15s ease-in-out infinite alternate",
      }} />
      {/* Inner core */}
      <div style={{
        position: "absolute", top: s(4), left: s(4),
        width: s(16), height: s(16),
        borderRadius: "50%",
        background: `radial-gradient(circle at 30% 30%, #fff, ${color}, ${color}80)`,
      }} />
      <style>{`
        @keyframes flameBallRight {
          0% { left: 8%; opacity: 0.3; transform: translateY(-50%) scale(0.5); }
          75% { opacity: 1; transform: translateY(-50%) scale(1.1); }
          100% { left: 88%; opacity: 0; transform: translateY(-50%) scale(1.4); }
        }
        @keyframes flameBallLeft {
          0% { right: 8%; opacity: 0.3; transform: translateY(-50%) scale(0.5); }
          75% { opacity: 1; transform: translateY(-50%) scale(1.1); }
          100% { right: 88%; opacity: 0; transform: translateY(-50%) scale(1.4); }
        }
        @keyframes flamePulse {
          0% { transform: scale(0.9); }
          100% { transform: scale(1.1); }
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
