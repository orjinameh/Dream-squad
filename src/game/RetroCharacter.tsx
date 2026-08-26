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
  const w = char.weapon;
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

      {/* Left Arm (weapon arm) */}
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

      {/* Right Arm (shield arm) */}
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

      {/* WEAPON */}
      <WeaponRender weapon={w} state={state} size={size} flip={flip} />

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
        @keyframes weaponGlow {
          0%, 100% { filter: brightness(1) drop-shadow(0 0 2px ${w.color1}); }
          50% { filter: brightness(1.4) drop-shadow(0 0 6px ${w.color1}); }
        }
      `}</style>
    </div>
  );
}

function WeaponRender({ weapon, state, size, flip }: {
  weapon: CharacterDef["weapon"];
  state: FighterState;
  size: number;
  flip: boolean;
}) {
  const s = (px: number) => px * size;
  const sc = weapon.size;
  const isActive = state === "attack" || state === "windup";
  const isClashing = state === "block";
  const isHit = state === "hit" || state === "knockback" || state === "stunned";

  const baseStyle: React.CSSProperties = {
    position: "absolute",
    top: s(38),
    left: s(-2),
    transformOrigin: "bottom center",
    animation: isActive ? "weaponSwing 0.3s steps(3) infinite" :
               isClashing ? "weaponClash 0.2s steps(2) infinite" :
               isHit ? "weaponDrop 0.4s ease-out" :
               "weaponGlow 2s ease-in-out infinite",
    zIndex: 10,
  };

  switch (weapon.type) {
    case "sword":
      return (
        <div style={baseStyle}>
          {/* Blade */}
          <div style={{
            width: s(6 * sc), height: s(30 * sc),
            background: `linear-gradient(180deg, ${lighten(weapon.color1, 40)}, ${weapon.color1}, ${darken(weapon.color1, 30)})`,
            borderRadius: `${s(2)}px ${s(2)}px ${s(1)}px ${s(1)}px`,
            border: `${Math.max(1, s(1))}px solid ${darken(weapon.color1, 40)}`,
            boxShadow: `inset ${s(1)}px 0 0 ${lighten(weapon.color1, 30)}`,
          }} />
          {/* Crossguard */}
          <div style={{
            width: s(14 * sc), height: s(4 * sc), marginTop: s(-1),
            background: weapon.color2,
            borderRadius: s(2),
            border: `${Math.max(1, s(1))}px solid ${darken(weapon.color2, 20)}`,
          }} />
          {/* Grip */}
          <div style={{
            width: s(4 * sc), height: s(8 * sc),
            background: `linear-gradient(180deg, ${weapon.color2}, ${darken(weapon.color2, 20)})`,
            borderRadius: s(2),
            margin: "0 auto",
          }} />
        </div>
      );

    case "axe":
      return (
        <div style={baseStyle}>
          {/* Handle */}
          <div style={{
            width: s(4 * sc), height: s(28 * sc),
            background: `linear-gradient(180deg, ${weapon.color2}, ${darken(weapon.color2, 15)})`,
            borderRadius: s(2),
            margin: "0 auto",
            border: `${Math.max(1, s(1))}px solid ${darken(weapon.color2, 30)}`,
          }} />
          {/* Axe head */}
          <div style={{
            position: "absolute", top: s(2), left: s(-6 * sc),
            width: s(18 * sc), height: s(16 * sc),
            background: `linear-gradient(135deg, ${lighten(weapon.color1, 20)}, ${weapon.color1}, ${darken(weapon.color1, 20)})`,
            borderRadius: `${s(8)}px ${s(2)}px ${s(8)}px ${s(2)}px`,
            border: `${Math.max(1, s(1))}px solid ${darken(weapon.color1, 30)}`,
            clipPath: "polygon(50% 0%, 100% 30%, 100% 100%, 0% 100%, 0% 30%)",
          }} />
        </div>
      );

    case "hammer":
      return (
        <div style={baseStyle}>
          {/* Handle */}
          <div style={{
            width: s(4 * sc), height: s(26 * sc),
            background: `linear-gradient(180deg, ${weapon.color2}, ${darken(weapon.color2, 15)})`,
            borderRadius: s(2),
            margin: "0 auto",
            border: `${Math.max(1, s(1))}px solid ${darken(weapon.color2, 30)}`,
          }} />
          {/* Hammer head */}
          <div style={{
            position: "absolute", top: s(0), left: s(-8 * sc),
            width: s(22 * sc), height: s(12 * sc),
            background: `linear-gradient(180deg, ${lighten(weapon.color1, 15)}, ${weapon.color1}, ${darken(weapon.color1, 20)})`,
            borderRadius: s(3),
            border: `${Math.max(1, s(1))}px solid ${darken(weapon.color1, 30)}`,
            boxShadow: `inset ${s(2)}px ${s(1)}px 0 ${lighten(weapon.color1, 30)}`,
          }} />
        </div>
      );

    case "spear":
      return (
        <div style={baseStyle}>
          {/* Shaft */}
          <div style={{
            width: s(3 * sc), height: s(36 * sc),
            background: `linear-gradient(180deg, ${weapon.color2}, ${darken(weapon.color2, 10)})`,
            borderRadius: s(1),
            margin: "0 auto",
            border: `${Math.max(1, s(0.5))}px solid ${darken(weapon.color2, 20)}`,
          }} />
          {/* Spearhead */}
          <div style={{
            position: "absolute", top: s(-2), left: s(-3 * sc),
            width: s(8 * sc), height: s(10 * sc),
            background: `linear-gradient(180deg, ${lighten(weapon.color1, 30)}, ${weapon.color1})`,
            clipPath: "polygon(50% 0%, 100% 100%, 0% 100%)",
            filter: `drop-shadow(0 0 3px ${weapon.color1})`,
          }} />
        </div>
      );

    case "energy-staff":
      return (
        <div style={baseStyle}>
          {/* Staff shaft */}
          <div style={{
            width: s(3 * sc), height: s(34 * sc),
            background: `linear-gradient(180deg, ${weapon.color2}, ${darken(weapon.color2, 10)})`,
            borderRadius: s(1),
            margin: "0 auto",
            border: `${Math.max(1, s(0.5))}px solid ${darken(weapon.color2, 20)}`,
          }} />
          {/* Energy orb */}
          <div style={{
            position: "absolute", top: s(-4), left: s(-3 * sc),
            width: s(10 * sc), height: s(10 * sc),
            borderRadius: "50%",
            background: `radial-gradient(circle at 30% 30%, ${lighten(weapon.color1, 60)}, ${weapon.color1}, ${darken(weapon.color1, 30)})`,
            border: `${Math.max(1, s(1))}px solid ${lighten(weapon.color1, 20)}`,
            boxShadow: `0 0 ${s(8)}px ${weapon.color1}, 0 0 ${s(16)}px ${weapon.color1}60`,
          }} />
        </div>
      );

    case "dual-daggers":
      return (
        <>
          {/* Left dagger */}
          <div style={{
            ...baseStyle,
            top: s(42),
            left: s(-4),
          }}>
            <div style={{
              width: s(4 * sc), height: s(18 * sc),
              background: `linear-gradient(180deg, ${lighten(weapon.color1, 30)}, ${weapon.color1})`,
              borderRadius: `${s(2)}px ${s(2)}px ${s(1)}px ${s(1)}px`,
              border: `${Math.max(1, s(0.5))}px solid ${darken(weapon.color1, 30)}`,
            }} />
            <div style={{
              width: s(10 * sc), height: s(3 * sc), marginTop: s(-0.5),
              background: weapon.color2, borderRadius: s(1),
            }} />
          </div>
          {/* Right dagger */}
          <div style={{
            ...baseStyle,
            top: s(42),
            left: s(72),
            transform: "scaleX(-1)",
          }}>
            <div style={{
              width: s(4 * sc), height: s(18 * sc),
              background: `linear-gradient(180deg, ${lighten(weapon.color1, 30)}, ${weapon.color1})`,
              borderRadius: `${s(2)}px ${s(2)}px ${s(1)}px ${s(1)}px`,
              border: `${Math.max(1, s(0.5))}px solid ${darken(weapon.color1, 30)}`,
            }} />
            <div style={{
              width: s(10 * sc), height: s(3 * sc), marginTop: s(-0.5),
              background: weapon.color2, borderRadius: s(1),
            }} />
          </div>
        </>
      );

    default:
      return null;
  }
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
