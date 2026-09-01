"use client";

import { useState, useEffect, useRef } from "react";
import { useGameState } from "./useGameState";
import { RetroCharacter, FlameBall } from "./RetroCharacter";
import { CHARACTERS } from "./characters";
import { TRADE_MARKETS, PREDICTIONS, type GameMode, type PredictionConfig, type TradeMarket, type BotDifficulty, type FighterState } from "./types";
import { WalletModal } from "@/components/WalletModal";
import { LiveChart } from "./LiveChart";
import { EcPositionPanel } from "./EcPositionPanel";
import { useMatchmaking } from "./useMatchmaking";
import { useAccount } from "wagmi";
import { useDreamDEX } from "./useDreamDEX";
import { useDreamEscrow } from "./useDreamEscrow";
import { parseUnits, formatUnits } from "viem";
import { EC_COLLATERAL_DECIMALS, ESCROW_ADDRESS } from "@/lib/ec/config";

export default function GameApp() {
  const g = useGameState();
  const [screenShake, setScreenShake] = useState(false);
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);
  const { isConnected, address } = useAccount();
  const mm = useMatchmaking(address as `0x${string}` | undefined);
  const dreamDex = useDreamDEX(g.marketSymbol);
  const escrow = useDreamEscrow(g.matchId ?? undefined);
  const startedMatchRef = useRef<string | null>(null);

  useEffect(() => {
    if (g.shakeScreen) {
      setScreenShake(true);
      const t = setTimeout(() => setScreenShake(false), 400);
      return () => clearTimeout(t);
    }
  }, [g.shakeScreen]);

  // Auto-detect active match on wallet connect
  useEffect(() => {
    if (!isConnected || !address || g.phase !== "HOME") return;
    (async () => {
      try {
        const res = await fetch(`/api/matches/active?address=${encodeURIComponent(address)}`);
        const data = await res.json();
        if (data.active && data.matchId) {
          setActiveMatchId(data.matchId);
        } else {
          setActiveMatchId(null);
        }
      } catch { setActiveMatchId(null); }
    })();
  }, [isConnected, address, g.phase]);

  // When matchmaking finds a match, transition to MATCH_FOUND. Guarded by a
  // startedMatchRef so it fires exactly once per matchId regardless of phase
  // timing; dropping the strict `phase === "MATCHMAKING"` check avoids a race
  // where the match is found but the transition is skipped (leaving the search
  // screen showing a bare matched state) and never retried.
  useEffect(() => {
    if (mm.state.status === "matched" && mm.state.matchId && startedMatchRef.current !== mm.state.matchId) {
      startedMatchRef.current = mm.state.matchId;
      g.actions.startPvPMatch(mm.state.matchId);
    }
  }, [mm.state.status, mm.state.matchId, g.actions]);

  // NOTE: no auto-join effect here. The QUICK MATCH button calls joinQueue
  // directly, so an auto-join is redundant AND harmful: it would re-fire on any
  // transient "idle" status and create a fresh queue entry, racing the real
  // match that was just created and stranding one player in "searching".

  const rejoinMatch = () => {
    if (!activeMatchId) return;
    g.actions.startPvPMatch(activeMatchId);
  };

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

      {g.phase === "HOME" && <HomeScreen address={address} escrow={escrow} onEnter={g.actions.goToMarketSelect} onLeaderboard={g.actions.goToLeaderboard} onProfile={g.actions.goToProfile} onHistory={g.actions.goToMatchHistory} onRejoin={activeMatchId ? rejoinMatch : undefined} />}
      {g.phase === "MARKET_SELECT" && <TradeSelect onSelect={g.actions.selectMarket} onBack={g.actions.goToHome} />}
      {g.phase === "CHAR_SELECT" && <CharSelect onSelect={g.actions.selectChar} onBack={g.actions.goToMarketSelect} />}
      {g.phase === "DUEL_CONFIRM" && <DuelConfirm mode={g.mode!} char={g.playerChar!} difficulty={g.botDifficulty} amount={g.selectedAmount} onSelectAmount={g.actions.selectAmount} onConfirm={() => { if (!isConnected) { setShowWalletModal(true); return; } g.actions.confirmDuel(); }} onBack={g.actions.goToCharSelect} onQuickMatch={(rounds) => { if (!isConnected) { setShowWalletModal(true); return; } g.actions.joinMatchmaking(rounds); mm.actions.joinQueue(rounds, g.playerChar?.id ?? "dreamer"); }} onSelectDifficulty={g.actions.selectDifficulty} />}
      {g.phase === "PREDICTION_SELECT" && <PredictionSelect asset={(TRADE_MARKETS.find((m) => m.symbol === g.marketSymbol)?.asset) ?? "BTC"} onBack={g.actions.goToCharSelect} onPredict={g.actions.setMatchPrediction} difficulty={g.botDifficulty} onSelectDifficulty={g.actions.selectDifficulty} amount={g.selectedAmount} onSelectAmount={g.actions.selectAmount} char={g.playerChar!} mode={g.mode!} onFightBot={() => { if (!isConnected) { setShowWalletModal(true); return; } g.actions.fightBotInstead(); }} onQuickMatch={() => { if (!isConnected) { setShowWalletModal(true); return; } g.actions.joinMatchmaking(g.mode?.rounds ?? 7); mm.actions.joinQueue(g.mode?.rounds ?? 7, g.playerChar?.id ?? "dreamer"); }} />}
      {g.phase === "MATCHMAKING" && <MatchmakingScreen matchmaking={mm} onFightBot={g.actions.fightBotInstead} onHome={g.actions.cancelMatchmaking} />}
      {g.phase === "MATCH_FOUND" && <MatchFoundScreen game={g} />}
      {g.phase === "READY_UP" && <ReadyUpScreen game={g} escrow={escrow} onReady={g.actions.setReady} onStartDuel={g.actions.startDuel} />}
      {(g.phase === "MATCH_INTRO" || g.phase === "ROUND_START" || g.phase === "ROUND_ACTIVE" || g.phase === "ROUND_LOCKED" || g.phase === "ROUND_EXECUTING" || g.phase === "ROUND_REVEAL" || g.phase === "ROUND_IMPACT") && (
        <ArenaScreen game={g} escrow={escrow} />
      )}
      {g.phase === "MATCH_RESULT" && <MatchResult game={g} onRematch={() => { if (!isConnected) { setShowWalletModal(true); return; } g.actions.rematch(); }} />}
      {g.phase === "PROFILE" && <ProfileScreen address={address} escrow={escrow} onBack={g.actions.goToHome} onHistory={g.actions.goToMatchHistory} />}
      {g.phase === "MATCH_HISTORY" && <MatchHistoryScreen address={address} onBack={g.actions.goToHome} onSelectMatch={g.actions.goToMatchDetail} />}
      {g.phase === "MATCH_DETAIL" && <MatchDetailScreen matchId={g.selectedMatchId} address={address} onBack={g.actions.goToMatchHistory} />}

      {g.isReconnecting && <ReconnectOverlay />}
      <WalletModal open={showWalletModal} onClose={() => setShowWalletModal(false)} />
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

function HomeScreen({ address, escrow, onEnter, onLeaderboard, onProfile, onHistory, onRejoin }: {
  address?: string;
  escrow: ReturnType<typeof useDreamEscrow>;
  onEnter: () => void;
  onLeaderboard: () => void;
  onProfile: () => void;
  onHistory: () => void;
  onRejoin?: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: "40px 20px" }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 50% 30%, rgba(168,85,247,0.08) 0%, transparent 60%)", pointerEvents: "none" }} />

      <div style={{ display: "flex", alignItems: "flex-end", gap: 24, marginBottom: 32 }}>
        <RetroCharacter char={CHARACTERS[0]} state="idle" size={1.5} />
        <RetroCharacter char={CHARACTERS[4]} state="idle" size={1.5} />
      </div>

      <h1 style={{ fontSize: 52, fontWeight: 900, letterSpacing: "0.15em", color: "#fbbf24", textShadow: "3px 3px 0 #92400e, 0 0 30px rgba(251,191,36,0.3)", marginBottom: 8, textAlign: "center" }}>
        DREAMDUEL
      </h1>
      <p style={{ fontSize: 18, letterSpacing: "0.3em", color: "#a855f7", marginBottom: 40, textShadow: "0 0 15px rgba(168,85,247,0.4)" }}>
        PREDICT. STRIKE. WIN.
      </p>

      {address && escrow.usdcBalanceFormatted !== null && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, marginBottom: 24,
          padding: "8px 18px", borderRadius: 6, border: "1px solid #0ea5e9",
          background: "rgba(14,165,233,0.08)",
        }}>
          <span style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.15em" }}>tUSDC BALANCE</span>
          <span style={{ fontSize: 16, fontWeight: 900, color: "#38bdf8", fontFamily: "'Courier New', monospace" }}>
            {escrow.usdcBalanceFormatted}
          </span>
        </div>
      )}

      {onRejoin && (
        <button onClick={onRejoin} style={{ ...ctaButtonStyle, background: "linear-gradient(135deg, #b45309, #f59e0b)", marginBottom: 16, fontSize: 16, padding: "14px 40px" }}>
          REJOIN MATCH
        </button>
      )}
      <button onClick={onEnter} style={ctaButtonStyle}>
        {"\u2694\uFE0F"} ENTER THE ARENA
      </button>
      <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
        <button onClick={onProfile} style={{ ...ctaButtonStyle, background: "transparent", border: "3px solid #a855f7", color: "#a855f7", fontSize: 13, padding: "10px 24px" }}>
          {"\uD83D\uDC64"} PROFILE
        </button>
        <button onClick={onHistory} style={{ ...ctaButtonStyle, background: "transparent", border: "3px solid #22d3ee", color: "#22d3ee", fontSize: 13, padding: "10px 24px" }}>
          {"\uD83D\uDCCB"} HISTORY
        </button>
        <button onClick={onLeaderboard} style={{ ...ctaButtonStyle, background: "transparent", border: "3px solid #fbbf24", color: "#fbbf24", fontSize: 13, padding: "10px 24px" }}>
          {"\uD83C\uDFC6"} RANKS
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 48, flexWrap: "wrap", justifyContent: "center" }}>
        {["Enter a duel", "Pick a market", "Predict in 10s", "Strike your rival", "Win the match"].map((s, i) => (
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

function TradeSelect({ onSelect, onBack }: { onSelect: (m: TradeMarket) => void; onBack: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "60px 20px" }}>
      <h2 style={{ fontSize: 32, fontWeight: 900, letterSpacing: "0.1em", color: "#fbbf24", textShadow: "2px 2px 0 #92400e", marginBottom: 8, textAlign: "center" }}>
        PICK YOUR MARKET
      </h2>
      <p style={{ fontSize: 12, color: "#64748b", letterSpacing: "0.15em", marginBottom: 8 }}>TRADE ON DREAMDEX</p>
      <p style={{ fontSize: 11, color: "#475569", marginBottom: 32 }}>7 rounds | 10s per round | choice locks when the round goes live</p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, maxWidth: 860, width: "100%", marginBottom: 40 }}>
        {TRADE_MARKETS.map((m) => {
          const isSel = selected === m.symbol;
          const disabled = !m.live;
          return (
            <button
              key={m.symbol}
              disabled={disabled}
              onClick={() => { if (m.live) { setSelected(m.symbol); onSelect(m); } }}
              onMouseEnter={() => { if (m.live) setSelected(m.symbol); }}
              onMouseLeave={() => setSelected(null)}
              style={{
                ...modeCardStyle,
                position: "relative",
                opacity: disabled ? 0.45 : 1,
                cursor: disabled ? "not-allowed" : "pointer",
                borderColor: isSel ? m.color : "#334155",
                background: isSel ? `${m.color}14` : "rgba(15,23,42,0.8)",
                transform: isSel ? "scale(1.03)" : "scale(1)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontSize: 26, fontWeight: 900, color: m.color, letterSpacing: "0.08em" }}>{m.asset}</span>
                <span style={{
                  fontSize: 9, fontWeight: 900, letterSpacing: "0.1em", padding: "3px 8px", borderRadius: 4,
                  background: m.live ? "rgba(16,185,129,0.15)" : "rgba(100,116,139,0.2)",
                  border: `1px solid ${m.live ? "#10b981" : "#64748b"}`,
                  color: m.live ? "#10b981" : "#94a3b8",
                }}>
                  {m.live ? "LIVE" : "POOL PENDING"}
                </span>
              </div>
              <div style={{ fontSize: 13, color: "#e2e8f0", marginBottom: 10, fontFamily: "'Courier New', monospace" }}>
                {m.symbol}
              </div>
              <div style={{ fontSize: 20, fontWeight: 900, color: "#e2e8f0", marginBottom: 14, fontFamily: "'Courier New', monospace" }}>
                ${m.price.toLocaleString("en-US", { minimumFractionDigits: m.price < 1 ? 4 : 0 })}
              </div>
              <div style={{ display: "flex", gap: 14, fontSize: 10, color: "#64748b", letterSpacing: "0.05em" }}>
                <span>MIN {m.minAmount} {m.asset}</span>
                <span>LOT {m.lotSize}</span>
              </div>
              {disabled && (
                <div style={{ marginTop: 10, fontSize: 10, color: "#94a3b8", letterSpacing: "0.08em" }}>
                  POOL NOT YET DEPLOYED ON TESTNET
                </div>
              )}
              {isSel && !disabled && <div style={{ position: "absolute", inset: -2, border: `2px solid ${m.color}`, borderRadius: 12, pointerEvents: "none", animation: "cursorBlink 0.8s steps(2) infinite" }} />}
            </button>
          );
        })}
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

function DuelConfirm({ mode, char, difficulty, amount, onSelectAmount, onConfirm, onBack, onQuickMatch, onSelectDifficulty }: { mode: GameMode; char: typeof CHARACTERS[0]; difficulty: BotDifficulty; amount: number; onSelectAmount: (a: number) => void; onConfirm: () => void; onBack: () => void; onQuickMatch: (rounds: number) => void; onSelectDifficulty: (d: BotDifficulty) => void }) {
  const difficulties: { id: BotDifficulty; label: string; color: string; desc: string }[] = [
    { id: "easy", label: "EASY", color: "#10b981", desc: "Bot struggles" },
    { id: "normal", label: "NORMAL", color: "#f59e0b", desc: "Fair match" },
    { id: "hard", label: "HARD", color: "#ef4444", desc: "Bot is sharp" },
  ];
  const tradeAmounts = [1, 2, 5, 10];
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse at 50% 40%, ${char.colors.accent}12 0%, transparent 50%)`, pointerEvents: "none" }} />

      <h2 style={{ fontSize: 28, fontWeight: 900, letterSpacing: "0.1em", color: "#f59e0b", textShadow: "2px 2px 0 #92400e", marginBottom: 24, textAlign: "center" }}>
        {"\u26A0 "} CHOOSE YOUR FIGHT
      </h2>

      <div style={{ display: "flex", alignItems: "center", gap: 40, marginBottom: 32 }}>
        <RetroCharacter char={char} state="idle" size={1.3} />
        <div style={{ fontSize: 36, color: "#ef4444", fontWeight: 900 }}>VS</div>
        <RetroCharacter char={CHARACTERS.find((c) => c.id !== char.id) ?? CHARACTERS[0]} state="idle" size={1.3} flip />
      </div>

      <div style={{
        background: "rgba(15,23,42,0.9)", border: "2px solid #334155", borderRadius: 8,
        padding: "20px 28px", maxWidth: 400, textAlign: "center", marginBottom: 24,
      }}>
        <p style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.6, margin: 0 }}>
          <span style={{ color: "#fbbf24", fontWeight: 700 }}>Rounds: {mode.rounds}</span> | <span style={{ color: "#a855f7", fontWeight: 700 }}>10s per round</span>
        </p>
      </div>

      {/* Bot difficulty selector */}
      <div style={{ marginBottom: 24, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.1em", marginBottom: 8 }}>BOT DIFFICULTY</div>
        <div style={{ display: "flex", gap: 8 }}>
          {difficulties.map((d) => (
            <button
              key={d.id}
              onClick={() => onSelectDifficulty(d.id)}
              style={{
                padding: "8px 16px", borderRadius: 6, fontSize: 12, fontWeight: 700,
                letterSpacing: "0.08em", cursor: "pointer", transition: "all 0.15s",
                fontFamily: "'Courier New', monospace",
                background: difficulty === d.id ? `${d.color}25` : "transparent",
                border: `2px solid ${difficulty === d.id ? d.color : "#334155"}`,
                color: difficulty === d.id ? d.color : "#64748b",
                transform: difficulty === d.id ? "scale(1.05)" : undefined,
              }}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* Trade amount selector — EACH ROUND you place a real DreamDEX order of
          this size with your wallet, driving your on-chain P&L. This is NOT the
          match escrow stake (that's one separate deposit confirmed at the
          ready/stake screen and locked until the window settles). */}
      <div style={{ marginBottom: 24, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.1em", marginBottom: 8 }}>TRADE SIZE PER ROUND (tUSDC)</div>
        <div style={{ display: "flex", gap: 8 }}>
          {tradeAmounts.map((a) => (
            <button
              key={a}
              onClick={() => onSelectAmount(a)}
              style={{
                padding: "8px 16px", borderRadius: 6, fontSize: 12, fontWeight: 700,
                letterSpacing: "0.08em", cursor: "pointer", transition: "all 0.15s",
                fontFamily: "'Courier New', monospace",
                background: amount === a ? "#10b98125" : "transparent",
                border: `2px solid ${amount === a ? "#10b981" : "#334155"}`,
                color: amount === a ? "#10b981" : "#64748b",
                transform: amount === a ? "scale(1.05)" : undefined,
              }}
            >
              {a}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 10, color: "#64748b", marginTop: 6, maxWidth: 360, lineHeight: 1.5 }}>
          Your per-round DreamDEX order size (drives your P&amp;L). Separate from the
          one-time escrow stake you confirm next — that locks for the match window.
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
        <button onClick={() => onQuickMatch(mode.rounds)} style={{ ...ctaButtonStyle, fontSize: 18, padding: "14px 48px", background: "linear-gradient(135deg, #b45309, #f59e0b)" }}>
          {"\u2694\uFE0F"} QUICK MATCH
        </button>
        <span style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.1em" }}>FIND A REAL OPPONENT</span>

        <div style={{ width: 200, height: 1, background: "#1e293b", margin: "8px 0" }} />

        <button onClick={onConfirm} style={{ ...ctaButtonStyle, fontSize: 16, padding: "12px 40px", background: "linear-gradient(135deg, #7c3aed, #a855f7)" }}>
          {"\uD83E\uDD16"} FIGHT BOT
        </button>
        <span style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.1em" }}>INSTANT AI OPPONENT</span>
      </div>

      <button onClick={onBack} style={{ marginTop: 24, background: "none", border: "none", color: "#64748b", fontSize: 12, cursor: "pointer", letterSpacing: "0.1em" }}>
        BACK
      </button>
    </div>
  );
}

function PredictionSelect({ asset, onBack, onPredict, difficulty, onSelectDifficulty, amount, onSelectAmount, char, mode, onFightBot, onQuickMatch }: {
  asset: string;
  onBack: () => void;
  onPredict: (pred: "UP" | "DOWN") => void;
  difficulty: BotDifficulty;
  onSelectDifficulty: (d: BotDifficulty) => void;
  amount: number;
  onSelectAmount: (a: number) => void;
  char: typeof CHARACTERS[0];
  mode: GameMode;
  onFightBot: () => void;
  onQuickMatch: () => void;
}) {
  const [localPrediction, setLocalPrediction] = useState<"UP" | "DOWN" | null>(null);

  const difficulties: { id: BotDifficulty; label: string; color: string; desc: string }[] = [
    { id: "easy", label: "EASY", color: "#10b981", desc: "Bot struggles" },
    { id: "normal", label: "NORMAL", color: "#f59e0b", desc: "Fair match" },
    { id: "hard", label: "HARD", color: "#ef4444", desc: "Bot is sharp" },
  ];
  const tradeAmounts = [1, 2, 5, 10];

  const go = (fn: () => void) => {
    if (!localPrediction) return;
    onPredict(localPrediction);
    fn();
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse at 50% 40%, ${char.colors.accent}12 0%, transparent 50%)`, pointerEvents: "none" }} />

      <h2 style={{ fontSize: 28, fontWeight: 900, letterSpacing: "0.1em", color: "#f59e0b", textShadow: "2px 2px 0 #92400e", marginBottom: 8, textAlign: "center" }}>
        {"\uD83D\uDD2E"} YOUR CALL
      </h2>
      <p style={{ fontSize: 13, color: "#64748b", marginBottom: 20 }}>Read the live chart, then lock UP or DOWN. Your call is locked for all {mode.rounds} rounds.</p>

      {/* Live chart of the chosen pool — BEFORE the pick */}
      <div style={{ width: "100%", maxWidth: 460, marginBottom: 20 }}>
        <LiveChart asset={asset} height={220} />
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        <button onClick={() => setLocalPrediction("UP")} style={{
          padding: "12px 34px", borderRadius: 8, fontSize: 16, fontWeight: 900, letterSpacing: "0.08em",
          cursor: "pointer", fontFamily: "'Courier New', monospace",
          background: localPrediction === "UP" ? "rgba(16,185,129,0.18)" : "rgba(15,23,42,0.8)",
          border: `2px solid ${localPrediction === "UP" ? "#10b981" : "#334155"}`,
          color: localPrediction === "UP" ? "#10b981" : "#64748b",
          boxShadow: localPrediction === "UP" ? "0 0 14px rgba(16,185,129,0.5)" : undefined,
          transform: localPrediction === "UP" ? "scale(1.06)" : undefined,
        }}>
          {"\u2B06\uFE0F"} UP
        </button>
        <button onClick={() => setLocalPrediction("DOWN")} style={{
          padding: "12px 34px", borderRadius: 8, fontSize: 16, fontWeight: 900, letterSpacing: "0.08em",
          cursor: "pointer", fontFamily: "'Courier New', monospace",
          background: localPrediction === "DOWN" ? "rgba(239,68,68,0.18)" : "rgba(15,23,42,0.8)",
          border: `2px solid ${localPrediction === "DOWN" ? "#ef4444" : "#334155"}`,
          color: localPrediction === "DOWN" ? "#ef4444" : "#64748b",
          boxShadow: localPrediction === "DOWN" ? "0 0 14px rgba(239,68,68,0.5)" : undefined,
          transform: localPrediction === "DOWN" ? "scale(1.06)" : undefined,
        }}>
          {"\u2B07\uFE0F"} DOWN
        </button>
      </div>

      {localPrediction && (
        <div style={{
          fontSize: 11, letterSpacing: "0.14em", marginBottom: 20, padding: "6px 16px", borderRadius: 6,
          background: "rgba(245,158,11,0.12)", border: "1px solid #f59e0b", color: "#fbbf24", fontWeight: 700,
        }}>
          {`CALL LOCKED: ${localPrediction === "UP" ? "\u2191 UP" : "\u2193 DOWN"} \u2014 ${asset} \u00D7 ${amount} UNITS (scored)`}
        </div>
      )}

      {/* BOT difficulty */}
      <div style={{ marginBottom: 20, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.1em", marginBottom: 8 }}>BOT DIFFICULTY</div>
        <div style={{ display: "flex", gap: 8 }}>
          {difficulties.map((d) => (
            <button
              key={d.id}
              onClick={() => onSelectDifficulty(d.id)}
              style={{
                padding: "8px 16px", borderRadius: 6, fontSize: 12, fontWeight: 700,
                letterSpacing: "0.08em", cursor: "pointer", transition: "all 0.15s",
                fontFamily: "'Courier New', monospace",
                background: difficulty === d.id ? `${d.color}25` : "transparent",
                border: `2px solid ${difficulty === d.id ? d.color : "#334155"}`,
                color: difficulty === d.id ? d.color : "#64748b",
                transform: difficulty === d.id ? "scale(1.05)" : undefined,
              }}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* Score units per round (simulated P&L) */}
      <div style={{ marginBottom: 24, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.1em", marginBottom: 8 }}>SCORE UNITS PER ROUND</div>
        <div style={{ display: "flex", gap: 8 }}>
          {tradeAmounts.map((a) => (
            <button
              key={a}
              onClick={() => onSelectAmount(a)}
              style={{
                padding: "8px 16px", borderRadius: 6, fontSize: 12, fontWeight: 700,
                letterSpacing: "0.08em", cursor: "pointer", transition: "all 0.15s",
                fontFamily: "'Courier New', monospace",
                background: amount === a ? "#10b98125" : "transparent",
                border: `2px solid ${amount === a ? "#10b981" : "#334155"}`,
                color: amount === a ? "#10b981" : "#64748b",
                transform: amount === a ? "scale(1.05)" : undefined,
              }}
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
        <button onClick={() => go(onQuickMatch)} disabled={!localPrediction} style={{ ...ctaButtonStyle, fontSize: 18, padding: "14px 48px", background: localPrediction ? "linear-gradient(135deg, #b45309, #f59e0b)" : "rgba(30,41,59,0.8)", color: localPrediction ? "#fff" : "#475569", cursor: localPrediction ? "pointer" : "not-allowed" }}>
          {"\u2694\uFE0F"} FIND A MATCH
        </button>
        <span style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.1em" }}>MATCH A REAL OPPONENT</span>

        <div style={{ width: 200, height: 1, background: "#1e293b", margin: "8px 0" }} />

        <button onClick={() => go(onFightBot)} disabled={!localPrediction} style={{ ...ctaButtonStyle, fontSize: 16, padding: "12px 40px", background: localPrediction ? "linear-gradient(135deg, #7c3aed, #a855f7)" : "rgba(30,41,59,0.8)", color: localPrediction ? "#fff" : "#475569", cursor: localPrediction ? "pointer" : "not-allowed" }}>
          {"\uD83E\uDD16"} FIGHT BOT
        </button>
        <span style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.1em" }}>INSTANT AI OPPONENT</span>
      </div>

      <button onClick={onBack} style={{ marginTop: 24, background: "none", border: "none", color: "#64748b", fontSize: 12, cursor: "pointer", letterSpacing: "0.1em" }}>
        BACK
      </button>
    </div>
  );
}

function MatchmakingScreen({ matchmaking, onFightBot, onHome }: { matchmaking: ReturnType<typeof useMatchmaking>; onFightBot: () => void; onHome: () => void }) {
  const { status, age, error } = matchmaking.state;
  const elapsed = Math.floor(age / 1000);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 50% 40%, rgba(245,158,11,0.06) 0%, transparent 50%)", pointerEvents: "none" }} />

      <div style={{
        fontSize: 24, fontWeight: 900, letterSpacing: "0.15em",
        color: status === "timeout" ? "#ef4444" : "#fbbf24",
        textShadow: "2px 2px 0 #92400e",
        marginBottom: 16, textAlign: "center",
      }}>
        {status === "timeout" ? "NO RIVAL FOUND" : status === "matched" ? "RIVAL FOUND" : "SEARCHING FOR RIVAL..."}
      </div>

      {status === "matched" && (
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 14, color: "#4ade80", letterSpacing: "0.08em" }}>
            ENTERING MATCH...
          </div>
        </div>
      )}

      {status === "searching" && (
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 14, color: "#94a3b8", letterSpacing: "0.08em", marginBottom: 8 }}>
            Best of {matchmaking.state.rounds} rounds
          </div>
          <div style={{ fontSize: 12, color: "#64748b", letterSpacing: "0.05em" }}>
            Waiting {elapsed}s...
          </div>
          {/* Animated dots */}
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{
                width: 8, height: 8, borderRadius: "50%",
                background: "#fbbf24",
                animation: `pulse 1.4s ease-in-out ${i * 0.2}s infinite`,
              }} />
            ))}
          </div>
        </div>
      )}

      {status === "timeout" && (
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 13, color: "#64748b", letterSpacing: "0.05em", marginBottom: 20 }}>
            No human opponent found after {elapsed}s
          </div>
        </div>
      )}

      {error && (
        <div style={{ fontSize: 12, color: "#ef4444", marginBottom: 16 }}>{error}</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
        {status === "searching" && (
          <button onClick={() => matchmaking.actions.leaveQueue()} style={{ ...ctaButtonStyle, background: "transparent", border: "2px solid #475569", color: "#94a3b8", fontSize: 14, padding: "12px 32px" }}>
            CANCEL SEARCH
          </button>
        )}
        {(status === "timeout" || status === "error") && (
          <>
            <button onClick={() => matchmaking.actions.joinQueue(matchmaking.state.rounds, "dreamer")} style={{ ...ctaButtonStyle, fontSize: 14, padding: "12px 32px" }}>
              KEEP SEARCHING
            </button>
            <button onClick={() => { matchmaking.actions.leaveQueue(); onFightBot(); }} style={{ ...ctaButtonStyle, background: "linear-gradient(135deg, #7c3aed, #a855f7)", fontSize: 14, padding: "12px 32px" }}>
              {"\uD83E\uDD16"} FIGHT A BOT
            </button>
          </>
        )}
        <button onClick={() => { matchmaking.actions.leaveQueue(); onHome(); }} style={{ marginTop: 8, background: "none", border: "none", color: "#64748b", fontSize: 12, cursor: "pointer", letterSpacing: "0.1em" }}>
          BACK TO ARENA
        </button>
      </div>
    </div>
  );
}

function MatchFoundScreen({ game }: { game: ReturnType<typeof useGameState> }) {
  const [countdown, setCountdown] = useState(3);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown(countdown - 1), 700);
    return () => clearTimeout(t);
  }, [countdown]);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 50% 40%, rgba(251,191,36,0.1) 0%, transparent 50%)", pointerEvents: "none" }} />

      <div style={{
        fontSize: 36, fontWeight: 900, letterSpacing: "0.15em",
        color: "#fbbf24", textShadow: "3px 3px 0 #92400e, 0 0 30px rgba(251,191,36,0.4)",
        marginBottom: 32, textAlign: "center",
        animation: "glow 1.5s ease-in-out infinite",
      }}>
        MATCH FOUND!
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 32, marginBottom: 24 }}>
        <RetroCharacter char={game.playerChar ?? CHARACTERS[0]} state="idle" size={1.2} />
        <div style={{ fontSize: 42, color: "#ef4444", fontWeight: 900, textShadow: "0 0 20px rgba(239,68,68,0.5)" }}>VS</div>
        <RetroCharacter char={game.rivalChar ?? CHARACTERS[1]} state="idle" size={1.2} flip />
      </div>

      <div style={{ fontSize: 16, color: "#a855f7", letterSpacing: "0.12em", marginBottom: 32 }}>
        BEST OF {game.totalRounds}
      </div>

      {countdown > 0 ? (
        <div style={{ fontSize: 72, fontWeight: 900, color: "#fbbf24", textShadow: "3px 3px 0 #92400e" }}>
          {countdown}
        </div>
      ) : (
        <div style={{ fontSize: 48, fontWeight: 900, color: "#ef4444", textShadow: "3px 3px 0 #7f1d1d", letterSpacing: "0.2em" }}>
          FIGHT!
        </div>
      )}

      <div style={{ fontSize: 11, color: "#64748b", marginTop: 32, letterSpacing: "0.1em" }}>
        PREPARE TO FIGHT...
      </div>
    </div>
  );
}

function ReadyUpScreen({ game, escrow, onReady, onStartDuel }: {
  game: ReturnType<typeof useGameState>;
  escrow: ReturnType<typeof useDreamEscrow>;
  onReady: () => void;
  onStartDuel: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [opponentReady, setOpponentReady] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [pvpStake, setPvpStake] = useState(game.selectedAmount && game.selectedAmount <= 50 ? game.selectedAmount : 10);
  const [stakeBusy, setStakeBusy] = useState(false);
  const [stakeError, setStakeError] = useState<string | null>(null);
  const [faucetBusy, setFaucetBusy] = useState(false);
  const stakePresets = [1, 5, 10, 25, 50];

  // Poll for ready state
  useEffect(() => {
    if (!game.matchId) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/matches/state?matchId=${game.matchId}`);
        const data = await res.json();
        if (data.player1Ready) setOpponentReady(true);
        if (data.bothReady || (data.player1Ready && data.player2Ready)) {
          // Both ready — match will auto-start via state polling
        }
      } catch { /* keep polling */ }
    }, 1000);
    return () => clearInterval(interval);
  }, [game.matchId]);

  const handleReady = () => {
    setReady(true);
    onReady();
  };

  const handleStake = async () => {
    if (!escrow.address) return;
    setStakeBusy(true);
    setStakeError(null);
    try {
      const amountRaw = parseUnits(String(pvpStake), EC_COLLATERAL_DECIMALS);
      await escrow.approveAndStake(amountRaw);
      escrow.refetch();
    } catch (e) {
      setStakeError(e instanceof Error ? e.message : "Stake failed");
    } finally {
      setStakeBusy(false);
    }
  };

  const handleFaucet = async () => {
    if (!escrow.address) return;
    setFaucetBusy(true);
    setStakeError(null);
    try {
      await escrow.getFaucet(parseUnits("1000", EC_COLLATERAL_DECIMALS));
      escrow.refetch();
    } catch (e) {
      setStakeError(e instanceof Error ? e.message : "Faucet failed");
    } finally {
      setFaucetBusy(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 50% 40%, rgba(168,85,247,0.06) 0%, transparent 50%)", pointerEvents: "none" }} />

      {game.isBotMatch ? (
        <div style={{ width: "100%", maxWidth: 520, textAlign: "center" }}>
          <div style={{
            fontSize: 24, fontWeight: 900, letterSpacing: "0.15em",
            color: "#fbbf24", textShadow: "2px 2px 0 #92400e",
            marginBottom: 8, textAlign: "center",
          }}>
            STAKE TO DUEL
          </div>
          <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 28, textAlign: "center" }}>
            You vs {game.rivalName || "the bot"}. Pledge tUSDC, or fight with no stake.
          </div>
          <div style={{ display: "flex", gap: 40, justifyContent: "center", marginBottom: 24 }}>
            <div style={{ textAlign: "center" }}>
              <RetroCharacter char={game.playerChar ?? CHARACTERS[0]} state="idle" size={1.2} />
              <div style={{ marginTop: 10, fontSize: 13, color: "#94a3b8", letterSpacing: "0.1em" }}>YOU</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <RetroCharacter char={game.rivalChar ?? CHARACTERS[1]} state="idle" size={1.2} flip />
              <div style={{ marginTop: 10, fontSize: 13, color: "#94a3b8", letterSpacing: "0.1em" }}>{game.rivalName || "BOT"}</div>
            </div>
          </div>
          <BotStakePanel game={game} escrow={escrow} />
          <button onClick={onStartDuel} style={{ ...ctaButtonStyle, fontSize: 18, padding: "14px 48px" }}>
            {"\u2694"} START DUEL
          </button>
          <div style={{ marginTop: 10, fontSize: 11, color: "#475569" }}>
            Staking is optional. Win/draw returns your stake; a loss sends it to the house treasury.
          </div>
        </div>
      ) : (
      <>

      <div style={{
        fontSize: 24, fontWeight: 900, letterSpacing: "0.15em",
        color: "#fbbf24", textShadow: "2px 2px 0 #92400e",
        marginBottom: 32, textAlign: "center",
      }}>
        GET READY
      </div>

      <div style={{ display: "flex", gap: 48, marginBottom: 40 }}>
        <div style={{ textAlign: "center" }}>
          <RetroCharacter char={game.playerChar ?? CHARACTERS[0]} state="idle" size={1.2} />
          <div style={{ marginTop: 12, fontSize: 13, color: "#94a3b8", letterSpacing: "0.1em" }}>YOU</div>
          <div style={{ marginTop: 4, fontSize: 14, color: ready ? "#10b981" : "#f59e0b", fontWeight: 700 }}>
            {ready ? "\u2713 READY" : "... WAITING"}
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <RetroCharacter char={game.rivalChar ?? CHARACTERS[1]} state="idle" size={1.2} flip />
          <div style={{ marginTop: 12, fontSize: 13, color: "#94a3b8", letterSpacing: "0.1em" }}>OPPONENT</div>
          <div style={{ marginTop: 4, fontSize: 14, color: opponentReady ? "#10b981" : "#f59e0b", fontWeight: 700 }}>
            {opponentReady ? "\u2713 READY" : "... WAITING"}
          </div>
        </div>
      </div>

      <div style={{
        width: "100%", maxWidth: 480, marginBottom: 32, padding: "20px 24px",
        border: "1px solid #334155", borderRadius: 12, background: "rgba(15,23,42,0.7)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: "#94a3b8", letterSpacing: "0.1em", fontWeight: 700 }}>PvP POT {"\u2014"} ONCHAIN ESCROW</div>
          <div style={{ fontSize: 12, color: "#38bdf8", fontFamily: "'Courier New', monospace" }}>
            tUSDC {escrow.usdcBalanceFormatted ?? "\u2014"}
          </div>
        </div>

        {escrow.usdcBalanceFormatted != null && Number(escrow.usdcBalanceFormatted) < 10 && (
          <button
            onClick={handleFaucet}
            disabled={faucetBusy}
            style={{
              width: "100%", marginBottom: 10, padding: "8px 12px", borderRadius: 6, cursor: "pointer",
              border: "1px dashed #f59e0b", background: "rgba(245,158,11,0.08)", color: "#fbbf24",
              fontWeight: 700, fontSize: 12,
            }}
          >
            {faucetBusy ? "MINTING 1000 tUSDC..." : "+ GET 1000 TEST tUSDC FROM THE TESTNET FAUCET"}
          </button>
        )}

        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
          This is your one-time match escrow stake (separate from your per-round
          trade size). Real tUSDC is pledged to the DreamDuel escrow; winner takes
          the pot on-chain. Both players must stake the SAME amount.
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
          {stakePresets.map((a) => (
            <button
              key={a}
              onClick={() => setPvpStake(a)}
              style={{
                padding: "6px 12px", borderRadius: 6, cursor: "pointer",
                border: pvpStake === a ? "2px solid #38bdf8" : "1px solid #334155",
                background: pvpStake === a ? "rgba(14,165,233,0.15)" : "#0f172a",
                color: "#e2e8f0", fontWeight: 700, fontSize: 13,
              }}
            >
              {a} tUSDC
            </button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, fontSize: 12, color: "#94a3b8" }}>
          <span>YOU: {escrow.hasStaked ? "\u2713 STAKED" : "NOT STAKED"}</span>
          <span style={{ color: "#334155" }}>|</span>
          <span>OPPONENT: {escrow.bothStaked && escrow.hasStaked ? "\u2713" : escrow.bothStaked ? "\u2713 STAKED" : "NOT STAKED"}</span>
          <span style={{ color: "#334155" }}>|</span>
          <span>POT: {escrow.stakeAmountFormatted ? (Number(escrow.stakeAmountFormatted) * 2).toString() : "0"} tUSDC</span>
        </div>

        {escrow.hasStaked ? (
          <div style={{ fontSize: 12, color: "#10b981", fontWeight: 700 }}>Your tUSDC is locked in escrow for this duel.</div>
        ) : (
          <button
            onClick={handleStake}
            disabled={stakeBusy || (!escrow.address)}
            style={{ ...ctaButtonStyle, fontSize: 14, padding: "10px 20px", opacity: stakeBusy ? 0.6 : 1, cursor: stakeBusy ? "wait" : "pointer" }}
          >
            {stakeBusy ? "APPROVING + STAKING..." : escrow.allowance == null ? "APPROVE + STAKE" : "\u2694 STAKE " + pvpStake + " tUSDC"}
          </button>
        )}

        {!escrow.address && (
          <div style={{ marginTop: 8, fontSize: 11, color: "#f59e0b" }}>Connect your wallet to pledge tUSDC.</div>
        )}
        {stakeError && (
          <div style={{ marginTop: 8, fontSize: 11, color: "#ef4444", wordBreak: "break-word" }}>{stakeError}</div>
        )}
      </div>

      {!ready ? (
        <button onClick={handleReady} style={{ ...ctaButtonStyle, fontSize: 18, padding: "14px 48px" }}>
          {"\u2713"} READY UP
        </button>
      ) : (
        <div style={{ fontSize: 14, color: "#a855f7", letterSpacing: "0.1em" }}>
          Waiting for opponent...
        </div>
      )}
      </>
      )}
    </div>
  );
}

// Compact stake panel for BOT matches. The player is the ONLY real staker (the
// bot / house never stakes). Shows real on-chain escrow state: whether the pot
// is open, whether the player pledged, and how much. Win/draw returns the
// stake; a loss sends it to the house treasury. Everything shown is read from
// the deployed escrow contract — never simulated.
function BotStakePanel({ game, escrow }: { game: ReturnType<typeof useGameState>; escrow: ReturnType<typeof useDreamEscrow> }) {
  const [stake, setStake] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [faucetBusy, setFaucetBusy] = useState(false);
  const presets = [1, 5, 10, 25, 50];

  const handleStake = async () => {
    if (!escrow.address) return;
    setBusy(true);
    setError(null);
    try {
      await escrow.approveAndStake(parseUnits(String(stake), EC_COLLATERAL_DECIMALS));
      escrow.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Stake failed");
    } finally {
      setBusy(false);
    }
  };

  const handleFaucet = async () => {
    if (!escrow.address) return;
    setFaucetBusy(true);
    setError(null);
    try {
      await escrow.getFaucet(parseUnits("1000", EC_COLLATERAL_DECIMALS));
      escrow.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Faucet failed");
    } finally {
      setFaucetBusy(false);
    }
  };

  return (
    <div style={{
      width: "100%", maxWidth: 460, margin: "0 auto 16px", padding: "14px 18px",
      border: "2px solid #7c3aed", borderRadius: 10, background: "rgba(124,58,237,0.08)",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.12em", color: "#a855f7" }}>
          REAL STAKE {"\u2014"} SOLO ESCROW (BOT DOESN'T STAKE)
        </span>
        <span style={{ fontSize: 12, color: "#38bdf8", fontFamily: "'Courier New', monospace" }}>
          tUSDC {escrow.usdcBalanceFormatted ?? "\u2014"}
        </span>
      </div>

      {escrow.usdcBalanceFormatted != null && Number(escrow.usdcBalanceFormatted) < 10 && (
        <button onClick={handleFaucet} disabled={faucetBusy} style={{
          width: "100%", marginBottom: 8, padding: "6px 10px", borderRadius: 6, cursor: "pointer",
          border: "1px dashed #f59e0b", background: "rgba(245,158,11,0.08)", color: "#fbbf24",
          fontWeight: 700, fontSize: 11,
        }}>
          {faucetBusy ? "MINTING 1000 tUSDC..." : "+ GET 1000 TEST tUSDC"}
        </button>
      )}

      <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.5, marginBottom: 10 }}>
        Pledge real tUSDC. <span style={{ color: "#4ade80" }}>Win/Draw = stake returned</span>.{" "}
        <span style={{ color: "#f87171" }}>Loss = stake sent to the house treasury.</span>
        See it on-chain: call <code>matches(escrowMatchId)</code> on {ESCROW_ADDRESS.slice(0, 8)}...
      </div>

      <div style={{
        fontSize: 11, color: "#fbbf24", lineHeight: 1.5, marginBottom: 12,
        padding: "8px 10px", borderRadius: 8, border: "1px dashed #f59e0b",
        background: "rgba(245,158,11,0.06)",
      }}>
        {"\u23F1"} Your stake is locked for the ~15 min Event-Contract window and settles
        on-chain. You can't open another stake until this one resolves — WIN/REFUND or
        LOSS. Want a fresh stake? Wait for this window to settle or play it out first.
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        {presets.map((a) => (
          <button key={a} onClick={() => setStake(a)} style={{
            padding: "5px 10px", borderRadius: 6, cursor: "pointer",
            border: stake === a ? "2px solid #a855f7" : "1px solid #334155",
            background: stake === a ? "rgba(168,85,247,0.15)" : "#0f172a",
            color: "#e2e8f0", fontWeight: 700, fontSize: 12,
          }}>
            {a} tUSDC
          </button>
        ))}
      </div>

      <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 8 }}>
        YOU: {escrow.hasStaked ? "\u2713 STAKED" : "NOT STAKED"}
        {"  "}<span style={{ color: "#334155" }}>|</span>{"  "}
        POT: {escrow.stakeAmountFormatted || "0"} tUSDC
      </div>

      {escrow.hasStaked ? (
        <div style={{ fontSize: 11, color: "#10b981", fontWeight: 700 }}>
          Your tUSDC is locked in the escrow for this bot duel.
        </div>
      ) : (
        <button onClick={handleStake} disabled={busy || !escrow.address} style={{
          ...ctaButtonStyle, fontSize: 13, padding: "9px 18px", opacity: busy ? 0.6 : 1,
          cursor: busy ? "wait" : "pointer", background: "linear-gradient(135deg, #7c3aed, #a855f7)",
        }}>
          {busy ? "APPROVING + STAKING..." : escrow.allowance == null ? "APPROVE + STAKE" : "\u2694 STAKE " + stake + " tUSDC"}
        </button>
      )}

      {!escrow.address && (
        <div style={{ marginTop: 6, fontSize: 10, color: "#f59e0b" }}>Connect your wallet to pledge real tUSDC.</div>
      )}
      {error && (
        <div style={{ marginTop: 6, fontSize: 10, color: "#ef4444", wordBreak: "break-word" }}>{error}</div>
      )}
    </div>
  );
}

function ArenaScreen({ game, escrow }: { game: ReturnType<typeof useGameState>; escrow: ReturnType<typeof useDreamEscrow> }) {
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
      const called = game.playerPrediction;
      const actual = game.roundResult.actual;
      const mark = called === actual ? "\u2713" : "\u2717";
      setRevealText(
        `YOU CALLED: ${called === "UP" ? "\u2191 UP" : called === "DOWN" ? "\u2193 DOWN" : "?"} ${mark} RESULT: ${actual === "UP" ? "\u2191 UP" : actual === "DOWN" ? "\u2193 DOWN" : "\u2192 FLAT"}`,
      );
    }
    if (game.phase === "ROUND_IMPACT" && game.roundResult) {
      if (game.roundResult.isDraw) {
        setImpactText("SPELLS CLASH!");
      } else if (game.roundResult.playerCorrect) {
        setImpactText(game.roundResult.isCritical ? "CRITICAL STRIKE!" : game.playerStreak >= 4 ? "UNSTOPPABLE" : game.playerStreak === 3 ? "ON FIRE!" : game.playerStreak === 2 ? "COMBO!" : "STRIKE!");
      } else {
        setImpactText("HIT!");
      }
      setTimeout(() => { setShowResult(false); setRevealText(""); setImpactText(""); }, 1200);
    }
  }, [game.phase, game.roundResult, game.playerStreak]);

  const isFinalRound = game.isFinalRound;
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
          <div style={{ minWidth: 80 }}>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>YOU</div>
            <HealthBar current={game.playerHP} max={game.maxHP} color="#10b981" />
            <div style={{ fontSize: 10, color: "#10b981", fontWeight: 700, textAlign: "center", marginTop: 2 }}>
              {game.playerHP} HP
            </div>
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
          <div style={{
            fontSize: 9, color: "#64748b", letterSpacing: "0.08em",
            padding: "2px 6px", borderRadius: 3, border: "1px solid #1e293b",
            background: "rgba(15,23,42,0.8)",
          }}>
            SOMNIA TESTNET
          </div>
          {(() => {
            const bal = escrow.usdcBalanceFormatted;
            return (
              <div style={{
                fontSize: 10, color: "#38bdf8", letterSpacing: "0.08em",
                padding: "2px 6px", borderRadius: 3, border: "1px solid #0ea5e9",
                background: "rgba(14,165,233,0.08)", fontFamily: "'Courier New', monospace",
              }}>
                {bal != null ? bal + " tUSDC" : "tUSDC \u2014"}
              </div>
            );
          })()}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ minWidth: 80 }}>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em", textAlign: "right" }}>RIVAL</div>
            <HealthBar current={game.rivalHP} max={game.maxHP} color="#ef4444" />
            <div style={{ fontSize: 10, color: "#ef4444", fontWeight: 700, textAlign: "center", marginTop: 2 }}>
              {game.rivalHP} HP
            </div>
          </div>
          <RetroCharacter char={game.rivalChar!} state={game.rivalCharState} size={0.6} flip />
        </div>
      </div>

      {/* Arena */}
      <div style={{
        flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        position: "relative", padding: "20px",
        background: game.isFinalRound ? "linear-gradient(180deg, rgba(239,68,68,0.05) 0%, rgba(245,158,11,0.03) 50%, transparent 100%)" : undefined,
      }}>
        <div style={{
          position: "absolute", inset: 0, pointerEvents: "none",
          background: "linear-gradient(180deg, rgba(168,85,247,0.03) 0%, rgba(6,182,212,0.02) 50%, transparent 100%)",
        }} />

        {/* KO Overlay */}
        {game.koOverlay && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", zIndex: 50,
            background: "rgba(8,8,16,0.7)",
            animation: "koFlash 0.3s ease-out",
          }}>
            <div style={{
              fontSize: 56, fontWeight: 900, color: "#ef4444", letterSpacing: "0.2em",
              textShadow: "4px 4px 0 #7f1d1d, 0 0 40px rgba(239,68,68,0.6)",
              animation: "koShake 0.5s ease-out",
            }}>
              K.O.!
            </div>
            <div style={{
              fontSize: 24, fontWeight: 900, color: "#fbbf24", letterSpacing: "0.15em",
              marginTop: 16, textShadow: "2px 2px 0 #92400e",
            }}>
              {game.koOverlay}
            </div>
          </div>
        )}

        {/* Draw Clash Effect */}
        {game.combatPhase === "clash" && (
          <div style={{
            position: "absolute", top: "50%", left: "50%",
            transform: "translate(-50%, -50%)", zIndex: 30,
          }}>
            <div style={{
              fontSize: 32, fontWeight: 900, color: "#fbbf24",
              textShadow: "0 0 20px rgba(251,191,36,0.8)",
              animation: "clashFlash 0.3s ease-out",
            }}>
              CLASH!
            </div>
            <div style={{
              position: "absolute", top: -8, left: "50%", transform: "translateX(-50%)",
              width: 4, height: 4, borderRadius: "50%",
              background: "#fbbf24", boxShadow: "0 0 12px #fbbf24, -20px -10px 0 #fbbf24, 20px -10px 0 #fbbf24, -15px 5px 0 #fbbf24, 15px 5px 0 #fbbf24",
              animation: "sparkBurst 0.4s ease-out forwards",
            }} />
          </div>
        )}

        {/* Match intro */}
        {game.phase === "MATCH_INTRO" && (
          <div style={{ textAlign: "center" }}>
            <div style={{
              fontSize: 48, fontWeight: 900, color: "#fbbf24", textShadow: "3px 3px 0 #92400e",
              letterSpacing: "0.15em", animation: "introPulse 0.8s ease-in-out",
            }}>
              {countdown > 0 ? countdown : "FIGHT!"}
            </div>
            {game.isFinalRound && countdown === 0 && (
              <div style={{
                fontSize: 16, color: "#ef4444", fontWeight: 700, letterSpacing: "0.2em",
                marginTop: 8, animation: "criticalPulse 0.3s steps(2) infinite",
              }}>
                FINAL ROUND
              </div>
            )}
          </div>
        )}

        {/* Characters — small, at edges */}
        {(game.phase !== "MATCH_INTRO" && !game.koOverlay) && (
          <div style={{
            display: "flex", alignItems: "flex-end", justifyContent: "space-between",
            width: "100%", maxWidth: 600, margin: "0 auto",
            padding: "0 20px", marginBottom: 24, position: "relative",
            minHeight: 120,
          }}>
            <div style={{
              textAlign: "center", position: "relative",
            }}>
              <RetroCharacter char={game.playerChar!} state={game.playerCharState} size={0.8} aura={game.playerStreak >= 3 ? "#fbbf24" : undefined} />
              <div style={{ fontSize: 10, color: game.playerChar?.colors.accent, letterSpacing: "0.1em", marginTop: 4 }}>{game.playerChar?.name}</div>
              {game.lastDamage?.target === "player" && (
                <DamageNumber amount={game.lastDamage.amount} isCritical={game.lastDamage.isCritical} />
              )}
            </div>

            {/* Flame ball projectile during combat — flies from the attacker to the opponent */}
            <FlameBall
              fromLeft={game.combatPhase === "strike" && game.lastDamage?.target === "rival"}
              color={game.combatPhase === "strike" && game.lastDamage?.target === "rival"
                ? (game.playerChar?.spell.color ?? "#fbbf24")
                : (game.rivalChar?.spell.color ?? "#ef4444")}
              active={game.combatPhase === "strike"}
              size={2.4}
            />

            <div style={{
              textAlign: "center", position: "relative",
            }}>
              <RetroCharacter char={game.rivalChar!} state={game.rivalCharState} size={0.8} flip aura={game.rivalStreak >= 3 ? "#ef4444" : undefined} />
              <div style={{ fontSize: 10, color: game.rivalChar?.colors.accent, letterSpacing: "0.1em", marginTop: 4 }}>{game.rivalName}</div>
              {game.lastDamage?.target === "rival" && (
                <DamageNumber amount={game.lastDamage.amount} isCritical={game.lastDamage.isCritical} />
              )}
            </div>
          </div>
        )}

        {/* Live chart — sits UNDER the combat. Same real BTC/ETH feed the
            player watched before locking their call. */}
        {(game.phase === "ROUND_ACTIVE" || game.phase === "ROUND_LOCKED" || game.phase === "ROUND_REVEAL" || game.phase === "ROUND_IMPACT") && (
          <div style={{ width: "100%", maxWidth: 460, margin: "0 auto 16px" }}>
            <LiveChart asset={game.selectedPrediction?.asset ?? "BTC"} height={180} />
            {game.matchId && <EcPositionPanel matchId={game.matchId} compact />}
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

        {/* Critical hit flash */}
        {game.roundResult?.isCritical && game.phase === "ROUND_IMPACT" && (
          <div style={{
            position: "absolute", top: "30%", left: "50%", transform: "translate(-50%, -50%)",
            fontSize: 36, fontWeight: 900, color: "#fbbf24", letterSpacing: "0.2em",
            textShadow: "3px 3px 0 #92400e, 0 0 30px rgba(251,191,36,0.8)",
            animation: "critFlash 0.5s ease-out", zIndex: 40,
          }}>
            CRITICAL!
          </div>
        )}

        {/* Draw round notice */}
        {game.roundResult?.isDraw && game.phase === "ROUND_IMPACT" && (
          <div style={{
            fontSize: 22, fontWeight: 900, letterSpacing: "0.15em",
            color: "#fbbf24", textShadow: "0 0 15px rgba(251,191,36,0.5)",
            marginBottom: 16, animation: "streakPop 0.5s ease-out",
          }}>
            DRAW ROUND
          </div>
        )}

        {/* Result reveal */}
        {showResult && game.phase !== "ROUND_IMPACT" && (
          <div style={{
            fontSize: 17, fontWeight: 900, color: "#fbbf24", letterSpacing: "0.08em",
            textShadow: "2px 2px 0 #92400e", marginBottom: 16, textAlign: "center", maxWidth: 460,
          }}>
            {revealText}
          </div>
        )}

        {/* Impact text */}
        {game.phase === "ROUND_IMPACT" && impactText && (
          <div style={{
            fontSize: 20, fontWeight: 900, letterSpacing: "0.1em",
            color: game.roundResult?.isDraw ? "#fbbf24" : game.roundResult?.playerCorrect ? "#10b981" : "#ef4444",
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
              {game.selectedPrediction.question}
            </div>

            {/* Countdown timer */}
            <div style={{
              fontSize: 42, fontWeight: 900, letterSpacing: "0.08em", marginBottom: 16,
              color: urgency === "critical" ? "#ef4444" : urgency === "urgent" ? "#f59e0b" : "#10b981",
              textShadow: urgency === "critical" ? "0 0 20px rgba(239,68,68,0.5)" : undefined,
              animation: urgency === "critical" ? "criticalPulse 0.4s steps(2) infinite" : urgency === "urgent" ? "urgentPulse 0.6s steps(2) infinite" : undefined,
            }}>
              {game.timeLeft.toFixed(2)}
            </div>

            {/* Selection status — always "selected" (repositionable). Never
                "committed"/locked: there is no lock state until round close. */}
            {game.playerPrediction && (
              <div style={{
                fontSize: 11, letterSpacing: "0.12em", marginBottom: 12, padding: "4px 12px",
                borderRadius: 4, display: "inline-block",
                background: "rgba(245,158,11,0.15)",
                border: "1px solid #f59e0b",
                color: "#f59e0b",
              }}>
                {`${game.playerPrediction === "UP" ? "\u2191" : "\u2193"} ${game.playerPrediction} POSITION SELECTED`}
              </div>
            )}
            {predStatus === "submitting" && (
              <div style={{
                fontSize: 11, letterSpacing: "0.12em", marginBottom: 12, padding: "4px 12px",
                borderRadius: 4, display: "inline-block",
                background: "rgba(245,158,11,0.15)", border: "1px solid #f59e0b", color: "#f59e0b",
              }}>
                SUBMITTING...
              </div>
            )}
            {game.executionStatus === "executing" && (
              <div style={{
                fontSize: 11, letterSpacing: "0.12em", marginBottom: 12, padding: "4px 12px",
                borderRadius: 4, display: "inline-block",
                background: "rgba(168,85,247,0.15)", border: "1px solid #a855f7", color: "#a855f7",
              }}>
                EXECUTING ON DREAMDEX...
              </div>
            )}

            {/* Locked call — chosen BEFORE the match, cannot be changed in-match */}
            <div style={{ display: "flex", gap: 12, justifyContent: "center", alignItems: "center" }}>
              <div style={{
                padding: "12px 28px", borderRadius: 8, fontSize: 16, fontWeight: 900, letterSpacing: "0.08em",
                fontFamily: "'Courier New', monospace",
                background: (game.lockedCall ?? game.playerPrediction) === "UP" ? "rgba(16,185,129,0.18)" : "rgba(239,68,68,0.18)",
                border: `2px solid ${(game.lockedCall ?? game.playerPrediction) === "UP" ? "#10b981" : "#ef4444"}`,
                color: (game.lockedCall ?? game.playerPrediction) === "UP" ? "#10b981" : "#ef4444",
              }}>
                {(game.lockedCall ?? game.playerPrediction) === "UP" ? "\u2191" : "\u2193"}
                {" "}CALL LOCKED
              </div>
              <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.1em" }}>
                CANNOT CHANGE IN MATCH
              </div>
            </div>
          </div>
        )}

        {game.phase === "ROUND_EXECUTING" && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 14, color: "#a855f7", letterSpacing: "0.12em", marginBottom: 8 }}>
              EXECUTING ON DREAMDEX...
            </div>
            <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.08em" }}>
              Somnia Testnet
            </div>
            {game.executionError && (
              <div style={{ fontSize: 11, color: "#ef4444", letterSpacing: "0.08em", marginTop: 4 }}>
                {game.executionError}
              </div>
            )}
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
              {game.roundResult?.isDraw
                ? (game.roundResult.playerCorrect === false && game.roundResult.rivalCorrect === false)
                  ? "YOU BOTH LOST THIS ROUND — NO ONE ATTACKED"
                  : "DRAW ROUND — NO DAMAGE"
                : game.roundResult?.playerCorrect ? "YOU PREDICTED CORRECTLY!" : "MISS! RIVAL SCORES!"}
            </div>
            {game.roundResult && !game.roundResult.isDraw && (
              <div style={{ fontSize: 12, color: game.roundResult.playerCorrect ? "#10b981" : "#ef4444", fontWeight: 700, marginTop: 4 }}>
                {game.roundResult.playerCorrect ? `Dealt ${game.roundResult.rivalDamage} damage!` : `Took ${game.roundResult.playerDamage} damage!`}
                {game.roundResult.isCritical ? " CRITICAL!" : ""}
              </div>
            )}
            <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>
              HP: {game.playerHP} / {game.maxHP} vs {game.rivalHP} / {game.maxHP}
            </div>
            {game.roundResult?.playerExecution && (
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: "0.06em", marginTop: 4 }}>
                {game.roundResult.playerExecution.status === "EXECUTED"
                  ? `DreamDEX ${game.roundResult.playerExecution.direction} executed`
                  : game.roundResult.playerExecution.status === "FAILED"
                    ? `Execution failed: ${game.roundResult.playerExecution.error ?? "unknown"}`
                    : "Execution pending..."}
                {game.roundResult.playerExecution.txHash && (
                  <span style={{ marginLeft: 6, color: "#64748b" }}>
                    tx: {game.roundResult.playerExecution.txHash.slice(0, 10)}...
                  </span>
                )}
              </div>
            )}
            {game.lastTxHash && !game.roundResult?.playerExecution?.txHash && (
              <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.06em", marginTop: 4 }}>
                tx: {game.lastTxHash.slice(0, 10)}...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MatchResult({ game, onRematch }: { game: ReturnType<typeof useGameState>; onRematch: () => void }) {
  const { address } = useAccount();
  const won = game.playerScore > game.rivalScore;
  const draw = game.playerScore === game.rivalScore;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
      {game.koOverlay && (
        <div style={{
          fontSize: 42, fontWeight: 900, color: "#ef4444", letterSpacing: "0.2em",
          textShadow: "3px 3px 0 #7f1d1d, 0 0 30px rgba(239,68,68,0.5)",
          marginBottom: 4,
        }}>
          K.O.!
        </div>
      )}
      {game.roundHistory.find((r) => r.knockout) && (
        <div style={{ fontSize: 14, color: "#ef4444", marginBottom: 8, letterSpacing: "0.1em" }}>
          KO in Round {game.roundHistory.find((r) => r.knockout)!.roundNum}
        </div>
      )}
      <h2 style={{ fontSize: 36, fontWeight: 900, letterSpacing: "0.15em", color: "#fbbf24", textShadow: "3px 3px 0 #92400e", marginBottom: 24, textAlign: "center" }}>
        MATCH COMPLETE
      </h2>

      <div style={{ display: "flex", alignItems: "center", gap: 48, marginBottom: 16 }}>
        <div style={{ textAlign: "center" }}>
          <RetroCharacter char={game.playerChar!} state={won ? "victory" : draw ? "idle" : "defeat"} size={1.5} />
          <div style={{ fontSize: 14, color: game.playerChar?.colors.accent, letterSpacing: "0.1em", marginTop: 8 }}>{game.playerChar?.name}</div>
          <HealthBar current={game.playerHP} max={game.maxHP} color="#10b981" wide />
          <div style={{ fontSize: 11, color: "#10b981", marginTop: 2 }}>{game.playerHP} HP</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 24, fontWeight: 900, color: "#fbbf24", textShadow: "2px 2px 0 #92400e" }}>
            {game.playerScore} - {game.rivalScore}
          </div>
          <div style={{ fontSize: 12, color: "#64748b", letterSpacing: "0.1em" }}>ROUNDS</div>
          <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>
            Final HP: {game.playerHP} vs {game.rivalHP}
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <RetroCharacter char={game.rivalChar!} state={won ? "defeat" : draw ? "idle" : "victory"} size={1.5} flip />
          <div style={{ fontSize: 14, color: game.rivalChar?.colors.accent, letterSpacing: "0.1em", marginTop: 8 }}>{game.rivalName}</div>
          <HealthBar current={game.rivalHP} max={game.maxHP} color="#ef4444" wide />
          <div style={{ fontSize: 11, color: "#ef4444", marginTop: 2 }}>{game.rivalHP} HP</div>
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
              width: 36, height: 36, borderRadius: 4,
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              fontSize: 10, fontWeight: 700, lineHeight: 1.2,
              background: r.isDraw ? "rgba(251,191,36,0.15)" : r.playerCorrect ? "rgba(16,185,129,0.2)" : "rgba(239,68,68,0.2)",
              border: `1px solid ${r.isDraw ? "#fbbf24" : r.playerCorrect ? "#10b981" : "#ef4444"}`,
              color: r.isDraw ? "#fbbf24" : r.playerCorrect ? "#10b981" : "#ef4444",
            }}>
                  {r.isDraw ? "\u2694" : r.playerCorrect ? "\u2713" : "\u2717"}
                  {!r.isDraw && (
                    <span style={{ fontSize: 8, opacity: 0.8 }}>
                      {r.playerCorrect ? `-${r.rivalDamage ?? 0}` : `-${r.playerDamage ?? 0}`}
                    </span>
                  )}
            </div>
          ))}
        </div>
      </div>

      {/* Trading P&L */}
      <div style={{
        background: "rgba(15,23,42,0.9)", border: "2px solid #1e293b", borderRadius: 8,
        padding: "12px 20px", marginBottom: 24, textAlign: "center", maxWidth: 340, width: "100%",
      }}>
        <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em", marginBottom: 6 }}>
          TRADING P&L {"\u00B7"} {game.playerAmountPerRound ?? 1} tUSDC / round
        </div>
        {(() => {
          const correct = game.roundHistory.filter((r) => r.playerCorrect && !r.isDraw).length;
          const wrong = game.roundHistory.filter((r) => !r.playerCorrect && !r.isDraw).length;
          const flat = game.roundHistory.filter((r) => r.actual === "FLAT").length;
          // Authoritative P&L from the resolved rounds (per-player stake).
          const pnl = game.roundHistory.reduce((s, r) => s + (r.playerPnL ?? 0), 0);
          const startBalance = game.playerStartBalance ?? 100;
          const endBalance = game.playerBalance ?? startBalance + pnl;
          return (
            <>
              <div style={{ fontSize: 22, fontWeight: 900, color: pnl >= 0 ? "#10b981" : "#ef4444", letterSpacing: "0.05em" }}>
                {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} tUSDC
              </div>
              <div style={{ fontSize: 10, color: "#64748b", marginTop: 4 }}>
                {startBalance.toFixed(2)} tUSDC {"\u2192"} {endBalance.toFixed(2)} tUSDC
              </div>
              <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>
                {correct} wins / {wrong} losses / {flat} flat / {game.roundHistory.length - correct - wrong - flat} draws
              </div>
            </>
          );
        })()}
      </div>

      <div style={{ marginBottom: 24, width: "100%", maxWidth: 340 }}>
        {game.matchId && <EcPositionPanel matchId={game.matchId} compact />}
        <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.5, textAlign: "center", marginTop: 4 }}>
          These rounds track the real Event Contract window. P&amp;L here is live; it
          {"\u201C"}locks in{"\u201D"} when the window settles on-chain. DUEL AGAIN to keep riding
          the same window &amp; net your moves together.
        </div>
      </div>

      <div style={{ display: "flex", gap: 16 }}>
        <button onClick={onRematch} style={ctaButtonStyle}>
          {"\u2694\uFE0F"} DUEL AGAIN
        </button>
        {game.matchId && (
          <button onClick={() => game.actions.goToMatchDetail(game.matchId!)} style={{ ...ctaButtonStyle, background: "linear-gradient(135deg, #155e75, #22d3ee)", fontSize: 14, padding: "12px 28px" }}>
            VIEW DETAIL
          </button>
        )}
        <button onClick={game.actions.goToHome} style={{ ...ctaButtonStyle, background: "transparent", border: "2px solid #475569", color: "#94a3b8", fontSize: 14, padding: "12px 28px" }}>
          BACK TO ARENA
        </button>
      </div>
    </div>
  );
}

function ProfileScreen({ address, escrow, onBack, onHistory }: { address?: string; escrow: ReturnType<typeof useDreamEscrow>; onBack: () => void; onHistory: () => void }) {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) { setLoading(false); return; }
    fetch(`/api/player/profile?address=${encodeURIComponent(address)}`)
      .then((r) => r.json())
      .then((d) => { setProfile(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [address]);

  const char = profile ? CHARACTERS.find((c) => c.id === profile.favoriteChar) ?? CHARACTERS[4] : CHARACTERS[4];

  if (!address) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
        <div style={{ fontSize: 20, color: "#64748b", letterSpacing: "0.1em", marginBottom: 24 }}>CONNECT WALLET TO VIEW PROFILE</div>
        <button onClick={onBack} style={{ ...ctaButtonStyle, background: "transparent", border: "2px solid #475569", color: "#94a3b8", fontSize: 14, padding: "10px 28px" }}>{"\u2190"} BACK</button>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
        <div style={{ fontSize: 18, color: "#64748b", letterSpacing: "0.1em" }}>LOADING PROFILE...</div>
      </div>
    );
  }

  if (!profile || profile.error) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
        <div style={{ fontSize: 20, color: "#ef4444", letterSpacing: "0.1em", marginBottom: 24 }}>PROFILE NOT FOUND</div>
        <button onClick={onBack} style={{ ...ctaButtonStyle, background: "transparent", border: "2px solid #475569", color: "#94a3b8", fontSize: 14, padding: "10px 28px" }}>{"\u2190"} BACK</button>
      </div>
    );
  }

  const maskAddr = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
  const rank = profile.rank ?? { rank: "BRONZE", tier: 5, color: "#b45309", icon: "\u25CF" };
  const pvpAcc = profile.pvp?.rounds > 0 ? Math.round((profile.pvp.correctPredictions / profile.pvp.rounds) * 100) : 0;
  const botAcc = profile.bot?.rounds > 0 ? Math.round((profile.bot.correctPredictions / profile.bot.rounds) * 100) : 0;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 20px" }}>
      <h2 style={{ fontSize: 28, fontWeight: 900, letterSpacing: "0.1em", color: "#fbbf24", textShadow: "2px 2px 0 #92400e", marginBottom: 24 }}>
        PROFILE
      </h2>

      {/* Fighter Card */}
      <div style={{
        background: "rgba(15,23,42,0.9)", border: `2px solid ${char.colors.accent}`, borderRadius: 12,
        padding: "24px 32px", textAlign: "center", marginBottom: 24, maxWidth: 400, width: "100%",
      }}>
        <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.15em", marginBottom: 8 }}>FIGHTER</div>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
          <RetroCharacter char={char} state="idle" size={1.3} />
        </div>
        <div style={{ fontSize: 20, fontWeight: 900, color: char.colors.accent, letterSpacing: "0.1em", marginBottom: 4 }}>{char.name}</div>
        <div style={{ fontSize: 12, color: "#64748b", fontFamily: "'Courier New', monospace" }}>{maskAddr(address)}</div>
        <div style={{ fontSize: 10, color: "#10b981", marginTop: 4, letterSpacing: "0.08em" }}>SOMNIA TESTNET</div>
      </div>

      {/* Rank */}
      <div style={{
        background: "rgba(15,23,42,0.9)", border: `2px solid ${rank.color}`, borderRadius: 12,
        padding: "16px 32px", textAlign: "center", marginBottom: 24, maxWidth: 400, width: "100%",
      }}>
        <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.15em", marginBottom: 4 }}>RANK</div>
        <div style={{ fontSize: 22, fontWeight: 900, color: rank.color, letterSpacing: "0.1em" }}>
          {rank.icon} {profile.rankLabel}
        </div>
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>{profile.rankPoints} RP</div>
      </div>

      {/* tUSDC Balance (on-chain) */}
      <div style={{
        background: "rgba(15,23,42,0.9)", border: "2px solid #0ea5e9", borderRadius: 12,
        padding: "16px 32px", textAlign: "center", marginBottom: 24, maxWidth: 400, width: "100%",
      }}>
        <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.15em", marginBottom: 4 }}>tUSDC BALANCE</div>
        <div style={{ fontSize: 24, fontWeight: 900, color: "#38bdf8", letterSpacing: "0.05em", fontFamily: "'Courier New', monospace" }}>
          {escrow.usdcBalanceFormatted ?? "..."}
        </div>
      </div>

      {/* Overall Stats */}
      <div style={{
        background: "rgba(15,23,42,0.9)", border: "2px solid #334155", borderRadius: 12,
        padding: "20px 32px", maxWidth: 400, width: "100%", marginBottom: 16,
      }}>
        <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.15em", marginBottom: 12, textAlign: "center" }}>OVERALL</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, textAlign: "center" }}>
          <div>
            <div style={{ fontSize: 24, fontWeight: 900, color: "#10b981" }}>{profile.totalWins}</div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>WINS</div>
          </div>
          <div>
            <div style={{ fontSize: 24, fontWeight: 900, color: "#ef4444" }}>{profile.totalLosses}</div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>LOSSES</div>
          </div>
          <div>
            <div style={{ fontSize: 24, fontWeight: 900, color: "#fbbf24" }}>{profile.accuracy}%</div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>ACCURACY</div>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, textAlign: "center", marginTop: 16 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 900, color: "#f59e0b" }}>{profile.longestStreak}</div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>BEST STREAK</div>
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 900, color: "#a855f7" }}>{profile.totalMatches}</div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>MATCHES</div>
          </div>
        </div>
      </div>

      {/* PvP Stats */}
      <div style={{
        background: "rgba(15,23,42,0.9)", border: "2px solid #22d3ee", borderRadius: 12,
        padding: "20px 32px", maxWidth: 400, width: "100%", marginBottom: 16,
      }}>
        <div style={{ fontSize: 11, color: "#22d3ee", letterSpacing: "0.15em", marginBottom: 12, textAlign: "center" }}>PVP STATS</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, textAlign: "center" }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#10b981" }}>{profile.pvp?.wins ?? 0}</div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>WINS</div>
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#ef4444" }}>{profile.pvp?.losses ?? 0}</div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>LOSSES</div>
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#a855f7" }}>{pvpAcc}%</div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>ACCURACY</div>
          </div>
        </div>
      </div>

      {/* Bot Stats */}
      <div style={{
        background: "rgba(15,23,42,0.9)", border: "2px solid #a855f7", borderRadius: 12,
        padding: "20px 32px", maxWidth: 400, width: "100%", marginBottom: 16,
      }}>
        <div style={{ fontSize: 11, color: "#a855f7", letterSpacing: "0.15em", marginBottom: 12, textAlign: "center" }}>BOT TRAINING</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, textAlign: "center" }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#10b981" }}>{profile.bot?.wins ?? 0}</div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>WINS</div>
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#ef4444" }}>{profile.bot?.losses ?? 0}</div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>LOSSES</div>
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#a855f7" }}>{botAcc}%</div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>ACCURACY</div>
          </div>
        </div>
      </div>

      {/* Combat Stats */}
      <div style={{
        background: "rgba(15,23,42,0.9)", border: "2px solid #334155", borderRadius: 12,
        padding: "16px 32px", maxWidth: 400, width: "100%", marginBottom: 24,
      }}>
        <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.15em", marginBottom: 8, textAlign: "center" }}>COMBAT</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, textAlign: "center" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 900, color: "#ef4444" }}>{profile.knockouts ?? 0}</div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>KNOCKOUTS</div>
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 900, color: "#f59e0b" }}>{profile.timesKnockedOut ?? 0}</div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>KNOCKED OUT</div>
          </div>
        </div>
      </div>

      {/* Active match banner */}
      {profile.activeMatchId && (
        <div style={{
          background: "rgba(245,158,11,0.1)", border: "2px solid #f59e0b", borderRadius: 8,
          padding: "12px 24px", marginBottom: 16, textAlign: "center",
        }}>
          <div style={{ fontSize: 12, color: "#f59e0b", letterSpacing: "0.1em" }}>ACTIVE MATCH DETECTED</div>
        </div>
      )}

      <div style={{ display: "flex", gap: 12 }}>
        <button onClick={onHistory} style={{ ...ctaButtonStyle, background: "linear-gradient(135deg, #155e75, #22d3ee)", fontSize: 14, padding: "12px 28px" }}>
          BATTLE HISTORY
        </button>
        <button onClick={onBack} style={{ ...ctaButtonStyle, background: "transparent", border: "2px solid #475569", color: "#94a3b8", fontSize: 14, padding: "12px 28px" }}>
          {"\u2190"} BACK
        </button>
      </div>
    </div>
  );
}

function MatchHistoryScreen({ address, onBack, onSelectMatch }: { address?: string; onBack: () => void; onSelectMatch: (matchId: string) => void }) {
  const [matches, setMatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) { setLoading(false); return; }
    fetch(`/api/matches/history?address=${encodeURIComponent(address)}&limit=30`)
      .then((r) => r.json())
      .then((d) => { setMatches(d.matches ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [address]);

  const timeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 20px" }}>
      <h2 style={{ fontSize: 28, fontWeight: 900, letterSpacing: "0.1em", color: "#fbbf24", textShadow: "2px 2px 0 #92400e", marginBottom: 24 }}>
        BATTLE HISTORY
      </h2>

      {loading && <div style={{ fontSize: 16, color: "#64748b", letterSpacing: "0.1em" }}>LOADING...</div>}

      {!loading && matches.length === 0 && (
        <div style={{ textAlign: "center", padding: "40px 0" }}>
          <div style={{ fontSize: 18, color: "#64748b", letterSpacing: "0.1em", marginBottom: 8 }}>NO BATTLES YET</div>
          <div style={{ fontSize: 13, color: "#475569", letterSpacing: "0.08em", marginBottom: 24 }}>YOUR FIRST FIGHT AWAITS.</div>
          <button onClick={onBack} style={ctaButtonStyle}>ENTER ARENA</button>
        </div>
      )}

      <div style={{ maxWidth: 500, width: "100%" }}>
        {matches.map((m) => {
          const char = CHARACTERS.find((c) => c.id === m.playerChar) ?? CHARACTERS[4];
          const rivalCharData = CHARACTERS.find((c) => c.id === m.rivalChar) ?? CHARACTERS[1];
          const isWin = m.winner === "player";
          const isDraw = m.winner === "draw";
          const isBot = m.opponentType === "bot";

          return (
            <button
              key={m.matchId}
              onClick={() => onSelectMatch(m.matchId)}
              style={{
                display: "block", width: "100%", textAlign: "left",
                background: "rgba(15,23,42,0.9)", border: `2px solid ${isWin ? "#10b981" : isDraw ? "#fbbf24" : "#ef4444"}`,
                borderRadius: 8, padding: "14px 20px", marginBottom: 8,
                cursor: "pointer", fontFamily: "'Courier New', monospace",
                transition: "all 0.15s",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 18 }}>{isWin ? "\uD83C\uDFC6" : isDraw ? "\u2694\uFE0F" : "\uD83D\uDC80"}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: char.colors.accent }}>
                      {char.name} <span style={{ color: "#475569" }}>vs</span> {isBot ? "TRAINING BOT" : m.rivalName}
                    </div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
                      {m.playerScore} - {m.rivalScore} | {m.totalRounds} ROUNDS | {isBot ? "BOT" : "PvP"}
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 11, color: isWin ? "#10b981" : isDraw ? "#fbbf24" : "#ef4444", fontWeight: 700 }}>
                    {isWin ? "WIN" : isDraw ? "DRAW" : "LOSS"}
                  </div>
                  <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>
                    {m.completedAt ? timeAgo(m.completedAt) : ""}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <button onClick={onBack} style={{ ...ctaButtonStyle, background: "transparent", border: "2px solid #475569", color: "#94a3b8", fontSize: 14, padding: "10px 28px", marginTop: 16 }}>
        {"\u2190"} BACK
      </button>
    </div>
  );
}

function MatchDetailScreen({ matchId, address, onBack }: { matchId: string | null; address?: string; onBack: () => void }) {
  const [match, setMatch] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!matchId) { setLoading(false); return; }
    const addrParam = address ? `&address=${encodeURIComponent(address)}` : "";
    fetch(`/api/matches/detail?matchId=${encodeURIComponent(matchId)}${addrParam}`)
      .then((r) => r.json())
      .then((d) => { setMatch(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [matchId, address]);

  if (!matchId) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
        <div style={{ fontSize: 18, color: "#64748b", letterSpacing: "0.1em", marginBottom: 24 }}>NO MATCH SELECTED</div>
        <button onClick={onBack} style={{ ...ctaButtonStyle, background: "transparent", border: "2px solid #475569", color: "#94a3b8", fontSize: 14, padding: "10px 28px" }}>{"\u2190"} BACK</button>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
        <div style={{ fontSize: 18, color: "#64748b", letterSpacing: "0.1em" }}>LOADING MATCH...</div>
      </div>
    );
  }

  if (!match || match.error) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
        <div style={{ fontSize: 18, color: "#ef4444", letterSpacing: "0.1em", marginBottom: 24 }}>MATCH NOT FOUND</div>
        <button onClick={onBack} style={{ ...ctaButtonStyle, background: "transparent", border: "2px solid #475569", color: "#94a3b8", fontSize: 14, padding: "10px 28px" }}>{"\u2190"} BACK</button>
      </div>
    );
  }

  const playerChar = CHARACTERS.find((c) => c.id === match.playerChar) ?? CHARACTERS[4];
  const rivalChar = CHARACTERS.find((c) => c.id === match.rivalChar) ?? CHARACTERS[1];
  const isWin = match.winner === "player";
  const isDraw = match.winner === "draw";
  const isBot = match.opponentType === "bot";
  const pvpAcc = match.totalRoundsPlayed > 0 ? Math.round((match.playerCorrectCount / match.totalRoundsPlayed) * 100) : 0;
  const rivalAcc = match.totalRoundsPlayed > 0 ? Math.round((match.rivalCorrectCount / match.totalRoundsPlayed) * 100) : 0;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 20px" }}>
      <div style={{ fontSize: 12, color: "#475569", letterSpacing: "0.1em", marginBottom: 8 }}>MATCH #{match.matchId.slice(0, 8).toUpperCase()}</div>

      {/* VS Card */}
      <div style={{
        display: "flex", alignItems: "center", gap: 32, marginBottom: 24,
        background: "rgba(15,23,42,0.9)", border: "2px solid #334155", borderRadius: 12,
        padding: "24px 40px",
      }}>
        <div style={{ textAlign: "center" }}>
          <RetroCharacter char={playerChar} state={isWin ? "victory" : isDraw ? "idle" : "defeat"} size={1.3} />
          <div style={{ fontSize: 13, fontWeight: 700, color: playerChar.colors.accent, marginTop: 8 }}>{playerChar.name}</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em", marginBottom: 4 }}>VS</div>
          <div style={{ fontSize: 28, fontWeight: 900, color: "#fbbf24", textShadow: "2px 2px 0 #92400e" }}>
            {match.playerScore} - {match.rivalScore}
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <RetroCharacter char={rivalChar} state={isWin ? "defeat" : isDraw ? "idle" : "victory"} size={1.3} flip />
          <div style={{ fontSize: 13, fontWeight: 700, color: rivalChar.colors.accent, marginTop: 8 }}>{match.rivalName}</div>
        </div>
      </div>

      {/* Result */}
      <div style={{
        fontSize: 28, fontWeight: 900, letterSpacing: "0.15em", marginBottom: 24,
        color: isWin ? "#10b981" : isDraw ? "#fbbf24" : "#ef4444",
      }}>
        {isWin ? "\uD83C\uDFC6 " : ""}{isWin ? "VICTORY" : isDraw ? "DRAW" : "DEFEAT"}
      </div>

      {/* Prediction Accuracy */}
      <div style={{
        background: "rgba(15,23,42,0.9)", border: "2px solid #334155", borderRadius: 8,
        padding: "16px 32px", maxWidth: 400, width: "100%", marginBottom: 16, textAlign: "center",
      }}>
        <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.15em", marginBottom: 12 }}>PREDICTION ACCURACY</div>
        <div style={{ display: "flex", justifyContent: "space-around" }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 900, color: playerChar.colors.accent }}>{match.playerCorrectCount}/{match.totalRoundsPlayed}</div>
            <div style={{ fontSize: 10, color: "#64748b" }}>{playerChar.name}</div>
          </div>
          <div>
            <div style={{ fontSize: 20, fontWeight: 900, color: rivalChar.colors.accent }}>{match.rivalCorrectCount}/{match.totalRoundsPlayed}</div>
            <div style={{ fontSize: 10, color: "#64748b" }}>{match.rivalName}</div>
          </div>
        </div>
      </div>

      {/* Combat */}
      <div style={{
        background: "rgba(15,23,42,0.9)", border: "2px solid #334155", borderRadius: 8,
        padding: "16px 32px", maxWidth: 400, width: "100%", marginBottom: 16, textAlign: "center",
      }}>
        <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.15em", marginBottom: 8 }}>COMBAT</div>
        <div style={{ display: "flex", justifyContent: "space-around" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 900, color: "#ef4444" }}>{match.knockouts ?? 0}</div>
            <div style={{ fontSize: 10, color: "#64748b" }}>KNOCKOUTS</div>
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 900, color: "#f59e0b" }}>{match.bestStreak ?? 0}</div>
            <div style={{ fontSize: 10, color: "#64748b" }}>BEST STREAK</div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-around", marginTop: 8 }}>
          <div>
            <div style={{ fontSize: 12, color: "#10b981" }}>HP: {match.playerHP}/100</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#ef4444" }}>HP: {match.rivalHP}/100</div>
          </div>
        </div>
      </div>

      {/* Round-by-round */}
      {match.rounds && match.rounds.length > 0 && (
        <div style={{
          background: "rgba(15,23,42,0.9)", border: "2px solid #334155", borderRadius: 8,
          padding: "16px 20px", maxWidth: 520, width: "100%", marginBottom: 24,
        }}>
          <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.15em", marginBottom: 12, textAlign: "center" }}>ROUNDS</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {match.rounds.map((r: any) => {
              const ok = r.playerCorrect && r.actual !== "FLAT";
              const isFlat = r.actual === "FLAT";
              const accent = isFlat ? "#64748b" : ok ? "#10b981" : "#ef4444";
              const exec = r.playerExecution;

  return (
                <div key={r.roundNum} style={{
                  border: `1px solid ${accent}${"55"}`,
                  borderRadius: 6, padding: "8px 12px",
                  display: "flex", flexDirection: "column", gap: 4,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.1em" }}>R{String(r.roundNum).padStart(2, "0")}</span>
                    <span style={{ fontSize: 12, fontWeight: 900, color: accent }}>
                      {isFlat ? "\u2192 FLAT" : ok ? "\u2191/\u2193 " + r.actual + " WIN" : "\u2191/\u2193 " + r.actual + " LOSS"}
                    </span>
                  </div>
                  {r.startPrice != null && r.endPrice != null && (
                    <div style={{ fontSize: 10, color: "#94a3b8" }}>
                      {r.asset ?? "BTC"} {"\u00B7"} {r.startPrice?.toFixed ? r.startPrice.toFixed(r.asset === "SOMI" ? 4 : 2) : r.startPrice} {"\u2192"} {r.endPrice?.toFixed ? r.endPrice.toFixed(r.asset === "SOMI" ? 4 : 2) : r.endPrice}
                    </div>
                  )}
                  {r.playerPnL != null && (
                    <div style={{ fontSize: 11, fontWeight: 700, color: (r.playerPnL ?? 0) >= 0 ? "#10b981" : "#ef4444" }}>
                      {(r.playerPnL ?? 0) >= 0 ? "+" : ""}{(r.playerPnL ?? 0).toFixed ? (r.playerPnL).toFixed(2) : r.playerPnL} tUSDC
                    </div>
                  )}
                  {exec?.txHash && (
                    <div style={{ fontSize: 9, color: "#64748b", fontFamily: "monospace", wordBreak: "break-all" }}>
                      tx: {exec.status === "EXECUTED" ? "\u2713" : "\u2717"} {exec.txHash.slice(0, 18)}...
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button onClick={onBack} style={{ ...ctaButtonStyle, background: "transparent", border: "2px solid #475569", color: "#94a3b8", fontSize: 14, padding: "10px 28px" }}>
        {"\u2190"} BACK TO HISTORY
      </button>
    </div>
  );
}

function HealthBar({ current, max, color, wide }: { current: number; max: number; color: string; wide?: boolean }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0;
  const barColor = pct > 60 ? color : pct > 30 ? "#f59e0b" : "#ef4444";
  const segments = 10;
  const segWidth = wide ? 8 : 5;
  const segGap = 2;
  return (
    <div style={{
      display: "flex", gap: segGap, justifyContent: "center",
      padding: "2px 0",
    }}>
      {Array.from({ length: segments }, (_, i) => {
        const segPct = ((i + 1) / segments) * 100;
        const filled = pct >= segPct;
        return (
          <div key={i} style={{
            width: segWidth, height: wide ? 8 : 6,
            borderRadius: 1,
            background: filled ? barColor : "rgba(30,41,59,0.8)",
            border: `1px solid ${filled ? barColor : "#1e293b"}`,
            opacity: filled ? 1 : 0.5,
            transition: "background 0.3s, border-color 0.3s",
          }} />
        );
      })}
    </div>
  );
}

function DamageNumber({ amount, isCritical }: { amount: number; isCritical: boolean }) {
  return (
    <div style={{
      position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)",
      fontSize: isCritical ? 22 : 16, fontWeight: 900, color: isCritical ? "#fbbf24" : "#ef4444",
      textShadow: isCritical ? "2px 2px 0 #92400e, 0 0 10px rgba(251,191,36,0.6)" : "1px 1px 0 #7f1d1d",
      animation: "damageFloat 1.2s ease-out forwards",
      zIndex: 30, whiteSpace: "nowrap", pointerEvents: "none",
    }}>
      -{amount}{isCritical ? "!" : ""}
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
  @keyframes damageFloat {
    0% { transform: translateX(-50%) translateY(0); opacity: 1; }
    70% { transform: translateX(-50%) translateY(-30px); opacity: 1; }
    100% { transform: translateX(-50%) translateY(-40px); opacity: 0; }
  }
  @keyframes koFlash {
    0% { background: rgba(239,68,68,0.3); }
    100% { background: rgba(8,8,16,0.7); }
  }
  @keyframes koShake {
    0% { transform: scale(0.5) rotate(-10deg); opacity: 0; }
    30% { transform: scale(1.3) rotate(5deg); opacity: 1; }
    50% { transform: scale(0.9) rotate(-3deg); }
    70% { transform: scale(1.1) rotate(2deg); }
    100% { transform: scale(1) rotate(0deg); opacity: 1; }
  }
  @keyframes clashFlash {
    0% { transform: scale(0.3); opacity: 0; }
    50% { transform: scale(1.4); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }
  @keyframes sparkBurst {
    0% { transform: translateX(-50%) scale(0); opacity: 1; }
    100% { transform: translateX(-50%) scale(3); opacity: 0; }
  }
  @keyframes critFlash {
    0% { transform: translate(-50%, -50%) scale(0.5) rotate(-10deg); opacity: 0; }
    30% { transform: translate(-50%, -50%) scale(1.3) rotate(5deg); opacity: 1; }
    60% { transform: translate(-50%, -50%) scale(0.95) rotate(-2deg); opacity: 1; }
    100% { transform: translate(-50%, -50%) scale(1) rotate(0deg); opacity: 0; }
  }
  @keyframes glow {
    0%, 100% { text-shadow: 0 0 10px currentColor; }
    50% { text-shadow: 0 0 20px currentColor, 0 0 40px currentColor; }
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.2; transform: scale(0.8); }
    50% { opacity: 1; transform: scale(1.2); }
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
