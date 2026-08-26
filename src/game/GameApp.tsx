"use client";

import { useState, useEffect } from "react";
import { useGameState } from "./useGameState";
import { RetroCharacter } from "./RetroCharacter";
import { CHARACTERS } from "./characters";
import { GAME_MODES, type GameMode } from "./types";

export default function GameApp() {
  const g = useGameState();
  const [screenShake, setScreenShake] = useState(false);

  useEffect(() => {
    if (g.shakeScreen) {
      setScreenShake(true);
      const t = setTimeout(() => setScreenShake(false), 400);
      return () => clearTimeout(t);
    }
  }, [g.shakeScreen]);

  return (
    <div style={{
      minHeight: "100vh", background: "#080810",
      fontFamily: "'Courier New', monospace",
      color: "#e0e0e0",
      position: "relative",
      overflow: "hidden",
      animation: screenShake ? "shake 0.4s ease-in-out" : undefined,
    }}>
      <style>{globalCSS}</style>

      {g.phase === "HOME" && <HomeScreen onEnter={g.actions.goToModeSelect} onLeaderboard={g.actions.goToLeaderboard} />}
      {g.phase === "MODE_SELECT" && <ModeSelect onSelect={g.actions.selectMode} onBack={g.actions.goToHome} />}
      {g.phase === "CHAR_SELECT" && <CharSelect onSelect={g.actions.selectChar} onBack={g.actions.goToModeSelect} />}
      {g.phase === "DUEL_CONFIRM" && <DuelConfirm mode={g.mode!} char={g.playerChar!} onConfirm={g.actions.confirmDuel} onBack={g.actions.goToCharSelect} />}
      {(g.phase === "MATCH_INTRO" || g.phase === "ROUND_START" || g.phase === "ROUND_ACTIVE" || g.phase === "ROUND_LOCKED" || g.phase === "ROUND_REVEAL" || g.phase === "ROUND_IMPACT") && (
        <ArenaScreen game={g} />
      )}
      {g.phase === "MATCH_RESULT" && <MatchResult game={g} />}

      {g.isReconnecting && <ReconnectOverlay />}
    </div>
  );
}

function ConnectionIndicator({ status, pingMs }: { status: string; pingMs: number }) {
  const getColor = () => {
    if (status === "local") return "#64748b";
    if (status === "offline") return "#475569";
    if (status === "reconnecting") return "#ef4444";
    if (status === "high") return "#f59e0b";
    return "#10b981";
  };
  const getLabel = () => {
    if (status === "local") return "LOCAL BOT";
    if (status === "offline") return "OFFLINE";
    if (status === "reconnecting") return "RECONNECTING";
    if (status === "high") return "HIGH PING";
    return "NET: OK";
  };
  const color = getColor();
  const dots = status === "offline" ? 0 : status === "reconnecting" ? Math.floor(Date.now() / 500) % 3 + 1 : status === "high" ? 2 : 3;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      fontSize: 9, letterSpacing: "0.1em", color,
      padding: "4px 8px", borderRadius: 4,
      background: `${color}15`, border: `1px solid ${color}40`,
    }}>
      <div style={{ display: "flex", gap: 3 }}>
        {[1, 2, 3].map((i) => (
          <div key={i} style={{
            width: 5, height: 5, borderRadius: "50%",
            background: i <= dots ? color : "#334155",
            transition: "background 0.3s",
          }} />
        ))}
      </div>
      <span>{getLabel()}</span>
      {status !== "offline" && status !== "reconnecting" && (
        <span style={{ color: "#64748b", fontSize: 8 }}>{pingMs}ms</span>
      )}
    </div>
  );
}

function ReconnectOverlay() {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(8,8,16,0.92)",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      zIndex: 100,
    }}>
      <div style={{
        fontSize: 32, fontWeight: 900, color: "#ef4444", letterSpacing: "0.15em",
        textShadow: "2px 2px 0 #7f1d1d", marginBottom: 16,
        animation: "criticalPulse 1s steps(2) infinite",
      }}>
        CONNECTION LOST
      </div>
      <div style={{ fontSize: 14, color: "#94a3b8", letterSpacing: "0.1em", marginBottom: 24 }}>
        RECONNECTING...
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{
            width: 8, height: 8, borderRadius: "50%",
            background: "#ef4444",
            animation: `dotPulse 1.2s ease-in-out ${i * 0.2}s infinite`,
          }} />
        ))}
      </div>
    </div>
  );
}

function HomeScreen({ onEnter, onLeaderboard }: { onEnter: () => void; onLeaderboard: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: "40px 20px" }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 50% 30%, rgba(168,85,247,0.08) 0%, transparent 60%)", pointerEvents: "none" }} />

      <div style={{ display: "flex", alignItems: "flex-end", gap: 24, marginBottom: 32 }}>
        <RetroCharacter char={CHARACTERS[0]} state="idle" size={1.5} />
        <RetroCharacter char={CHARACTERS[4]} state="idle" size={1.5} />
      </div>

      <h1 style={{ fontSize: 52, fontWeight: 900, letterSpacing: "0.15em", color: "#fbbf24", textShadow: "3px 3px 0 #92400e, 0 0 30px rgba(251,191,36,0.3)", marginBottom: 8, textAlign: "center" }}>
        DREAMSQUAD
      </h1>
      <p style={{ fontSize: 18, letterSpacing: "0.3em", color: "#a855f7", marginBottom: 40, textShadow: "0 0 15px rgba(168,85,247,0.4)" }}>
        PREDICT. STRIKE. WIN.
      </p>

      <button onClick={onEnter} style={ctaButtonStyle}>
        {"\u2694\uFE0F"} ENTER THE ARENA
      </button>
      <button onClick={onLeaderboard} style={{ ...ctaButtonStyle, background: "transparent", border: "3px solid #64748b", color: "#94a3b8", marginTop: 12, fontSize: 14, padding: "12px 32px" }}>
        {"\uD83C\uDFC6"} HALL OF DREAMERS
      </button>

      <div style={{ display: "flex", gap: 8, marginTop: 48, flexWrap: "wrap", justifyContent: "center" }}>
        {["Enter a duel", "Choose rounds", "Predict in 10s", "Strike your rival", "Win the match"].map((s, i) => (
          <span key={i} style={{
            fontSize: 11, padding: "6px 14px", borderRadius: 4,
            background: "rgba(30,41,59,0.6)", border: "1px solid #334155",
            color: "#94a3b8", letterSpacing: "0.05em",
          }}>
            {`${i + 1}. ${s}`}
          </span>
        ))}
      </div>
    </div>
  );
}

function ModeSelect({ onSelect, onBack }: { onSelect: (m: GameMode) => void; onBack: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "60px 20px" }}>
      <h2 style={{ fontSize: 32, fontWeight: 900, letterSpacing: "0.1em", color: "#fbbf24", textShadow: "2px 2px 0 #92400e", marginBottom: 8, textAlign: "center" }}>
        CHOOSE YOUR DUEL
      </h2>
      <p style={{ fontSize: 12, color: "#64748b", letterSpacing: "0.15em", marginBottom: 40 }}>SELECT A MODE</p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, maxWidth: 900, width: "100%", marginBottom: 40 }}>
        {GAME_MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => { setSelected(m.id); onSelect(m); }}
            onMouseEnter={() => setSelected(m.id)}
            onMouseLeave={() => setSelected(null)}
            style={{
              ...modeCardStyle,
              borderColor: selected === m.id ? "#fbbf24" : "#334155",
              background: selected === m.id ? "rgba(251,191,36,0.08)" : "rgba(15,23,42,0.8)",
              transform: selected === m.id ? "scale(1.03)" : "scale(1)",
            }}
          >
            <div style={{ fontSize: 36, marginBottom: 8 }}>{m.icon}</div>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#fbbf24", letterSpacing: "0.1em", marginBottom: 4 }}>{m.name}</div>
            <div style={{ fontSize: 28, fontWeight: 900, color: "#e2e8f0", marginBottom: 4 }}>{m.rounds} ROUNDS</div>
            <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.05em" }}>{m.desc}</div>
            {selected === m.id && <div style={{ position: "absolute", inset: -2, border: "2px solid #fbbf24", borderRadius: 12, pointerEvents: "none", animation: "cursorBlink 0.8s steps(2) infinite" }} />}
          </button>
        ))}
      </div>

      <button onClick={onBack} style={{ ...ctaButtonStyle, background: "transparent", border: "2px solid #475569", color: "#94a3b8", fontSize: 14, padding: "10px 28px" }}>
        {"\u2190"} BACK
      </button>
    </div>
  );
}

function CharSelect({ onSelect, onBack }: { onSelect: (c: typeof CHARACTERS[0]) => void; onBack: () => void }) {
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "60px 20px" }}>
      <h2 style={{ fontSize: 32, fontWeight: 900, letterSpacing: "0.1em", color: "#fbbf24", textShadow: "2px 2px 0 #92400e", marginBottom: 8, textAlign: "center" }}>
        SELECT YOUR FIGHTER
      </h2>
      <p style={{ fontSize: 12, color: "#64748b", letterSpacing: "0.15em", marginBottom: 40 }}>CHOOSE WISELY</p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 16, maxWidth: 900, width: "100%", marginBottom: 40 }}>
        {CHARACTERS.map((c) => (
          <button
            key={c.id}
            onClick={() => onSelect(c)}
            onMouseEnter={() => setHovered(c.id)}
            onMouseLeave={() => setHovered(null)}
            style={{
              ...charCardStyle,
              borderColor: hovered === c.id ? c.colors.accent : "#334155",
              background: hovered === c.id ? `${c.colors.accent}15` : "rgba(15,23,42,0.8)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
              <RetroCharacter char={c} state={hovered === c.id ? "thinking" : "idle"} size={1.2} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 900, color: c.colors.accent, letterSpacing: "0.08em", marginBottom: 2 }}>{c.name}</div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.05em", marginBottom: 4 }}>{c.title}</div>
            <div style={{ fontSize: 10, color: "#475569", lineHeight: 1.4 }}>{c.desc}</div>
          </button>
        ))}
      </div>

      <button onClick={onBack} style={{ ...ctaButtonStyle, background: "transparent", border: "2px solid #475569", color: "#94a3b8", fontSize: 14, padding: "10px 28px" }}>
        {"\u2190"} BACK
      </button>
    </div>
  );
}

function DuelConfirm({ mode, char, onConfirm, onBack }: { mode: GameMode; char: typeof CHARACTERS[0]; onConfirm: () => void; onBack: () => void }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse at 50% 40%, ${char.colors.accent}12 0%, transparent 50%)`, pointerEvents: "none" }} />

      <h2 style={{ fontSize: 28, fontWeight: 900, letterSpacing: "0.1em", color: "#f59e0b", textShadow: "2px 2px 0 #92400e", marginBottom: 24, textAlign: "center" }}>
        {"\u26A0 "} DUEL COMMITMENT
      </h2>

      <div style={{ display: "flex", alignItems: "center", gap: 40, marginBottom: 32 }}>
        <RetroCharacter char={char} state="idle" size={1.3} />
        <div style={{ fontSize: 36, color: "#ef4444", fontWeight: 900 }}>VS</div>
        <RetroCharacter char={CHARACTERS.find((c) => c.id !== char.id) ?? CHARACTERS[0]} state="idle" size={1.3} flip />
      </div>

      <div style={{
        background: "rgba(15,23,42,0.9)", border: "2px solid #334155", borderRadius: 8,
        padding: "24px 32px", maxWidth: 400, textAlign: "center", marginBottom: 32,
      }}>
        <p style={{ fontSize: 14, color: "#e2e8f0", lineHeight: 1.8, margin: 0 }}>
          You are entering a prediction battle.<br />
          Once the duel begins, you must see it through.<br /><br />
          <span style={{ color: "#fbbf24", fontWeight: 700 }}>Rounds: {mode.rounds}</span><br />
          <span style={{ color: "#a855f7", fontWeight: 700 }}>Prediction window: 10 seconds each</span><br /><br />
          <span style={{ color: "#ef4444", fontSize: 12 }}>NO FORFEIT AFTER ROUND 1.</span>
        </p>
      </div>

      <div style={{ display: "flex", gap: 16 }}>
        <button onClick={onBack} style={{ ...ctaButtonStyle, background: "transparent", border: "2px solid #475569", color: "#94a3b8", fontSize: 14, padding: "12px 28px" }}>
          BACK
        </button>
        <button onClick={onConfirm} style={{ ...ctaButtonStyle, fontSize: 18, padding: "14px 40px" }}>
          ENTER ARENA {"\u2694\uFE0F"}
        </button>
      </div>
    </div>
  );
}

function ArenaScreen({ game }: { game: ReturnType<typeof useGameState> }) {
  const [countdown, setCountdown] = useState(3);
  const [showResult, setShowResult] = useState(false);
  const [revealText, setRevealText] = useState("");
  const [impactText, setImpactText] = useState("");

  useEffect(() => {
    if (game.phase === "MATCH_INTRO") {
      setCountdown(3);
      const i = setInterval(() => {
        setCountdown((p) => {
          if (p <= 1) { clearInterval(i); return 0; }
          return p - 1;
        });
      }, 600);
      return () => clearInterval(i);
    }
  }, [game.phase]);

  useEffect(() => {
    if (game.phase === "ROUND_REVEAL" && game.roundResult) {
      setShowResult(true);
      setRevealText(game.roundResult.actual === "UP" ? "RESULT: \u2191 UP" : "RESULT: \u2193 DOWN");
    }
    if (game.phase === "ROUND_IMPACT" && game.roundResult) {
      if (game.roundResult.playerCorrect) {
        setImpactText(game.playerStreak >= 4 ? "UNSTOPPABLE" : game.playerStreak === 3 ? "ON FIRE!" : game.playerStreak === 2 ? "COMBO!" : "STRIKE!");
      } else {
        setImpactText("HIT!");
      }
      setTimeout(() => { setShowResult(false); setRevealText(""); setImpactText(""); }, 1200);
    }
  }, [game.phase, game.roundResult, game.playerStreak]);

  const isFinalRound = game.currentRound >= game.totalRounds && game.phase === "ROUND_ACTIVE";
  const urgency = game.timeLeft <= 2 ? "critical" : game.timeLeft <= 5 ? "urgent" : "calm";
  const predStatus = game.predictionStatus;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", position: "relative" }}>
      {/* HUD */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "16px 24px", borderBottom: "2px solid #1e293b",
        background: "rgba(8,8,16,0.95)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <RetroCharacter char={game.playerChar!} state={game.playerCharState} size={0.6} />
          <div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>YOU</div>
            <div style={{ fontSize: 24, fontWeight: 900, color: "#10b981" }}>{game.playerScore}</div>
          </div>
        </div>

        <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <div style={{ fontSize: 12, color: "#64748b", letterSpacing: "0.1em" }}>
            ROUND {String(game.currentRound).padStart(2, "0")} / {String(game.totalRounds).padStart(2, "0")}
          </div>
          {isFinalRound && (
            <div style={{ fontSize: 11, color: "#ef4444", fontWeight: 700, letterSpacing: "0.15em", animation: "criticalPulse 0.5s steps(2) infinite" }}>
              {"\u26A1"} FINAL ROUND {"\u26A1"}
            </div>
          )}
          <ConnectionIndicator status={game.connectionStatus} pingMs={game.pingMs} />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>RIVAL</div>
            <div style={{ fontSize: 24, fontWeight: 900, color: "#ef4444" }}>{game.rivalScore}</div>
          </div>
          <RetroCharacter char={game.rivalChar!} state={game.rivalCharState} size={0.6} flip />
        </div>
      </div>

      {/* Arena */}
      <div style={{
        flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        position: "relative", padding: "20px",
      }}>
        <div style={{
          position: "absolute", inset: 0, pointerEvents: "none",
          background: "linear-gradient(180deg, rgba(168,85,247,0.03) 0%, rgba(6,182,212,0.02) 50%, transparent 100%)",
        }} />

        {/* Match intro */}
        {game.phase === "MATCH_INTRO" && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48, fontWeight: 900, color: "#fbbf24", textShadow: "3px 3px 0 #92400e", letterSpacing: "0.15em", animation: "introPulse 0.8s ease-in-out" }}>
              {countdown > 0 ? countdown : "FIGHT!"}
            </div>
          </div>
        )}

        {/* Characters */}
        {(game.phase !== "MATCH_INTRO") && (
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 80, marginBottom: 24 }}>
            <div style={{ textAlign: "center" }}>
              <RetroCharacter char={game.playerChar!} state={game.playerCharState} size={2} aura={game.playerStreak >= 3 ? "#fbbf24" : undefined} />
              <div style={{ fontSize: 11, color: game.playerChar?.colors.accent, letterSpacing: "0.1em", marginTop: 4 }}>{game.playerChar?.name}</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <RetroCharacter char={game.rivalChar!} state={game.rivalCharState} size={2} flip aura={game.rivalStreak >= 3 ? "#ef4444" : undefined} />
              <div style={{ fontSize: 11, color: game.rivalChar?.colors.accent, letterSpacing: "0.1em", marginTop: 4 }}>{game.rivalName}</div>
            </div>
          </div>
        )}

        {/* Streak announcement */}
        {game.showStreak && game.phase === "ROUND_IMPACT" && (
          <div style={{
            fontSize: 28, fontWeight: 900, letterSpacing: "0.15em",
            color: game.playerStreak >= 4 ? "#fbbf24" : game.playerStreak >= 3 ? "#ef4444" : "#10b981",
            textShadow: `0 0 20px ${game.playerStreak >= 4 ? "rgba(251,191,36,0.5)" : "rgba(16,185,129,0.5)"}`,
            marginBottom: 16, animation: "streakPop 0.5s ease-out",
          }}>
            {game.playerStreak >= 4 ? "\uD83D\uDC51 " : game.playerStreak >= 3 ? "\u26A1 " : game.playerStreak >= 2 ? "\uD83D\uDD25 " : ""}
            {game.showStreak}
          </div>
        )}

        {/* Result reveal */}
        {showResult && game.phase !== "ROUND_IMPACT" && (
          <div style={{
            fontSize: 22, fontWeight: 900, color: "#fbbf24", letterSpacing: "0.1em",
            textShadow: "2px 2px 0 #92400e", marginBottom: 16,
          }}>
            {revealText}
          </div>
        )}

        {/* Impact text */}
        {game.phase === "ROUND_IMPACT" && impactText && (
          <div style={{
            fontSize: 20, fontWeight: 900, letterSpacing: "0.1em",
            color: game.roundResult?.playerCorrect ? "#10b981" : "#ef4444",
            marginBottom: 16,
          }}>
            {impactText}
          </div>
        )}

        {/* Combat line */}
        {game.phase === "ROUND_IMPACT" && game.roundResult && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 14, marginBottom: 16 }}>
            <span style={{ color: game.playerChar?.colors.accent, fontWeight: 700 }}>{game.playerChar?.name}</span>
            <span style={{ color: "#475569" }}>{"\u2500".repeat(8)}</span>
            <span style={{ color: game.roundResult.playerCorrect ? "#10b981" : "#ef4444", fontSize: 20 }}>
              {game.roundResult.playerCorrect ? "\u2713" : "\u2717"}
            </span>
            <span style={{ color: "#475569" }}>{"\u2500".repeat(8)}</span>
            <span style={{ color: game.rivalChar?.colors.accent, fontWeight: 700 }}>{game.rivalName}</span>
          </div>
        )}
      </div>

      {/* Prediction Panel */}
      <div style={{
        padding: "20px 24px 24px",
        borderTop: "2px solid #1e293b",
        background: "rgba(8,8,16,0.95)",
      }}>
        {game.phase === "ROUND_ACTIVE" && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 14, color: "#94a3b8", letterSpacing: "0.1em", marginBottom: 8 }}>
              WILL THE MARKET GO UP OR DOWN?
            </div>

            {/* Server-synced countdown */}
            <div style={{
              fontSize: 42, fontWeight: 900, letterSpacing: "0.08em", marginBottom: 16,
              color: urgency === "critical" ? "#ef4444" : urgency === "urgent" ? "#f59e0b" : "#10b981",
              textShadow: urgency === "critical" ? "0 0 20px rgba(239,68,68,0.5)" : undefined,
              animation: urgency === "critical" ? "criticalPulse 0.4s steps(2) infinite" : urgency === "urgent" ? "urgentPulse 0.6s steps(2) infinite" : undefined,
            }}>
              {game.timeLeft.toFixed(2)}
            </div>

            {/* Prediction status display */}
            {predStatus !== "idle" && (
              <div style={{
                fontSize: 11, letterSpacing: "0.12em", marginBottom: 12, padding: "4px 12px",
                borderRadius: 4, display: "inline-block",
                background: predStatus === "confirmed" ? "rgba(16,185,129,0.15)" : predStatus === "error" ? "rgba(239,68,68,0.15)" : "rgba(245,158,11,0.15)",
                border: `1px solid ${predStatus === "confirmed" ? "#10b981" : predStatus === "error" ? "#ef4444" : "#f59e0b"}`,
                color: predStatus === "confirmed" ? "#10b981" : predStatus === "error" ? "#ef4444" : "#f59e0b",
              }}>
                {predStatus === "selected" && `\u2191 ${game.playerPrediction?.toUpperCase()} SELECTED`}
                {predStatus === "submitting" && "SUBMITTING..."}
                {predStatus === "confirmed" && "\uD83D\uDD12 LOCKED"}
                {predStatus === "error" && "SUBMISSION FAILED"}
              </div>
            )}

            {/* YES / NO buttons — disabled after selection */}
            <div style={{ display: "flex", gap: 20, justifyContent: "center" }}>
              <button
                onClick={() => game.actions.makePrediction("UP")}
                disabled={predStatus !== "idle"}
                style={{
                  ...predictionBtnStyle("#10b981"),
                  opacity: predStatus !== "idle" ? 0.4 : 1,
                  cursor: predStatus !== "idle" ? "not-allowed" : "pointer",
                  transform: predStatus === "idle" ? undefined : "scale(0.95)",
                }}
              >
                {"\u2191"} YES
              </button>
              <button
                onClick={() => game.actions.makePrediction("DOWN")}
                disabled={predStatus !== "idle"}
                style={{
                  ...predictionBtnStyle("#ef4444"),
                  opacity: predStatus !== "idle" ? 0.4 : 1,
                  cursor: predStatus !== "idle" ? "not-allowed" : "pointer",
                  transform: predStatus === "idle" ? undefined : "scale(0.95)",
                }}
              >
                {"\u2193"} NO
              </button>
            </div>
          </div>
        )}

        {game.phase === "ROUND_LOCKED" && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 24, fontWeight: 900, color: "#fbbf24", letterSpacing: "0.15em" }}>
              {"\uD83D\uDD12"} PREDICTIONS LOCKED
            </div>
          </div>
        )}

        {(game.phase === "MATCH_INTRO" || game.phase === "ROUND_START") && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 18, color: "#64748b", letterSpacing: "0.1em" }}>
              {game.phase === "MATCH_INTRO" ? "GET READY..." : `ROUND ${game.currentRound}...`}
            </div>
          </div>
        )}

        {(game.phase === "ROUND_REVEAL" || game.phase === "ROUND_IMPACT") && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 14, color: "#64748b", letterSpacing: "0.1em" }}>
              {game.roundResult?.playerCorrect ? "YOU PREDICTED CORRECTLY!" : "MISS! RIVAL SCORES!"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MatchResult({ game }: { game: ReturnType<typeof useGameState> }) {
  const won = game.playerScore > game.rivalScore;
  const draw = game.playerScore === game.rivalScore;

  useEffect(() => {
    if (game.roundHistory.length === 0) return;

    if (game.isBotMatch) {
      // Bot match: submit to bot-result endpoint (no Match doc needed)
      const idempotencyKey = `bot-${game.roundHistory.length}-${game.playerScore}-${game.rivalScore}-${game.mode?.id}`;
      fetch("/api/matches/bot-result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey,
          playerAddress: "0x0000000000000000000000000000000000000000",
          rounds: game.roundHistory.map((r) => ({
            roundNum: r.roundNum,
            playerPrediction: r.playerPredicted,
            rivalPrediction: r.rivalPredicted,
            actual: r.actual,
            playerCorrect: r.playerCorrect,
            rivalCorrect: r.rivalCorrect,
          })),
          playerScore: game.playerScore,
          rivalScore: game.rivalScore,
          winner: won ? "player" : draw ? "draw" : "rival",
          playerChar: game.playerChar?.id ?? "dreamer",
        }),
      }).catch(() => {});
      return;
    }

    if (!game.matchId) return;
    fetch("/api/matches/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matchId: game.matchId,
        playerAddress: "0x0000000000000000000000000000000000000000",
        rounds: game.roundHistory.map((r) => ({
          roundNum: r.roundNum,
          playerPrediction: r.playerPredicted,
          rivalPrediction: r.rivalPredicted,
          actual: r.actual,
          playerCorrect: r.playerCorrect,
          rivalCorrect: r.rivalCorrect,
        })),
        playerScore: game.playerScore,
        rivalScore: game.rivalScore,
      }),
    }).catch(() => {});
  }, [game.matchId, game.roundHistory, game.playerScore, game.rivalScore, game.isBotMatch, game.mode, game.playerChar, game.rivalChar, won, draw]);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
      <h2 style={{ fontSize: 36, fontWeight: 900, letterSpacing: "0.15em", color: "#fbbf24", textShadow: "3px 3px 0 #92400e", marginBottom: 24, textAlign: "center" }}>
        MATCH COMPLETE
      </h2>

      <div style={{ display: "flex", alignItems: "center", gap: 48, marginBottom: 32 }}>
        <div style={{ textAlign: "center" }}>
          <RetroCharacter char={game.playerChar!} state={won ? "victory" : draw ? "idle" : "defeat"} size={1.5} />
          <div style={{ fontSize: 14, color: game.playerChar?.colors.accent, letterSpacing: "0.1em", marginTop: 8 }}>{game.playerChar?.name}</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, fontWeight: 900, color: "#fbbf24", textShadow: "2px 2px 0 #92400e" }}>
            {game.playerScore}
          </div>
          <div style={{ fontSize: 12, color: "#64748b", letterSpacing: "0.1em" }}>VS</div>
          <div style={{ fontSize: 48, fontWeight: 900, color: "#ef4444", textShadow: "2px 2px 0 #7f1d1d" }}>
            {game.rivalScore}
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <RetroCharacter char={game.rivalChar!} state={won ? "defeat" : draw ? "idle" : "victory"} size={1.5} flip />
          <div style={{ fontSize: 14, color: game.rivalChar?.colors.accent, letterSpacing: "0.1em", marginTop: 8 }}>{game.rivalName}</div>
        </div>
      </div>

      <div style={{
        fontSize: 28, fontWeight: 900, letterSpacing: "0.15em", marginBottom: 32,
        color: won ? "#10b981" : draw ? "#fbbf24" : "#ef4444",
        textShadow: won ? "0 0 20px rgba(16,185,129,0.4)" : undefined,
      }}>
        {won ? "VICTORY" : draw ? "DRAW" : "DEFEAT"}
      </div>

      {/* Round history */}
      <div style={{ maxWidth: 500, width: "100%", marginBottom: 32 }}>
        <div style={{ fontSize: 12, color: "#64748b", letterSpacing: "0.1em", marginBottom: 8, textAlign: "center" }}>ROUND HISTORY</div>
        <div style={{ display: "flex", gap: 4, justifyContent: "center", flexWrap: "wrap" }}>
          {game.roundHistory.map((r, i) => (
            <div key={i} style={{
              width: 32, height: 32, borderRadius: 4,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, fontWeight: 700,
              background: r.playerCorrect ? "rgba(16,185,129,0.2)" : "rgba(239,68,68,0.2)",
              border: `1px solid ${r.playerCorrect ? "#10b981" : "#ef4444"}`,
              color: r.playerCorrect ? "#10b981" : "#ef4444",
            }}>
              {r.playerCorrect ? "\u2713" : "\u2717"}
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 16 }}>
        <button onClick={game.actions.rematch} style={ctaButtonStyle}>
          REMATCH {"\u2694\uFE0F"}
        </button>
        <button onClick={game.actions.goToHome} style={{ ...ctaButtonStyle, background: "transparent", border: "2px solid #475569", color: "#94a3b8", fontSize: 14, padding: "12px 28px" }}>
          BACK TO ARENA
        </button>
      </div>
    </div>
  );
}

const globalCSS = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    10% { transform: translateX(-6px) rotate(-0.5deg); }
    20% { transform: translateX(6px) rotate(0.5deg); }
    30% { transform: translateX(-5px); }
    40% { transform: translateX(5px); }
    50% { transform: translateX(-3px); }
    60% { transform: translateX(3px); }
    70% { transform: translateX(-2px); }
    80% { transform: translateX(2px); }
    90% { transform: translateX(-1px); }
  }
  @keyframes introPulse {
    0% { transform: scale(2); opacity: 0; }
    50% { transform: scale(1.1); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }
  @keyframes streakPop {
    0% { transform: scale(0.5); opacity: 0; }
    50% { transform: scale(1.3); }
    100% { transform: scale(1); opacity: 1; }
  }
  @keyframes criticalPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(1.05); }
  }
  @keyframes urgentPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
  }
  @keyframes cursorBlink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  @keyframes dotPulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1.2); }
  }
`;

const ctaButtonStyle: React.CSSProperties = {
  background: "linear-gradient(135deg, #b45309, #f59e0b)",
  border: "none", borderRadius: 8, padding: "14px 36px",
  color: "#fff", fontWeight: 900, fontSize: 16, letterSpacing: "0.08em",
  cursor: "pointer", textShadow: "1px 1px 0 #92400e",
  boxShadow: "0 4px 15px rgba(245,158,11,0.3), inset 0 1px 0 rgba(255,255,255,0.2)",
  fontFamily: "'Courier New', monospace",
};

const modeCardStyle: React.CSSProperties = {
  position: "relative", border: "2px solid #334155", borderRadius: 12,
  padding: "28px 20px", cursor: "pointer", textAlign: "center",
  transition: "all 0.2s", fontFamily: "'Courier New', monospace",
};

const charCardStyle: React.CSSProperties = {
  border: "2px solid #334155", borderRadius: 12,
  padding: "20px 12px", cursor: "pointer", textAlign: "center",
  transition: "all 0.2s", fontFamily: "'Courier New', monospace",
};

function predictionBtnStyle(color: string): React.CSSProperties {
  return {
    background: `${color}20`, border: `3px solid ${color}`, borderRadius: 8,
    padding: "16px 48px", color, fontWeight: 900, fontSize: 22, letterSpacing: "0.1em",
    cursor: "pointer", transition: "all 0.15s", fontFamily: "'Courier New', monospace",
    boxShadow: `0 0 20px ${color}30`,
  };
}
