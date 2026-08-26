"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { CHARACTERS } from "@/game/characters";

interface Leader {
  rank: number;
  address: string;
  totalWins: number;
  totalLosses: number;
  totalMatches: number;
  correctPredictions: number;
  longestStreak: number;
  favoriteChar: string;
  accuracy: number;
  rankPoints: number;
  rankLabel: string;
  pvpWins: number;
  pvpLosses: number;
  pvpMatches: number;
}

type TabId = "rank" | "wins" | "accuracy" | "streak";

const TABS: { id: TabId; label: string }[] = [
  { id: "rank", label: "RANK" },
  { id: "wins", label: "WINS" },
  { id: "accuracy", label: "ACCURACY" },
  { id: "streak", label: "STREAK" },
];

export default function LeaderboardPage() {
  const { address } = useAccount();
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("rank");

  const fetchLeaderboard = useCallback((tab: TabId) => {
    setLoading(true);
    fetch(`/api/leaderboard?sort=${tab}&limit=30`)
      .then((r) => r.json())
      .then((d) => { setLeaders(d.leaderboard ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { fetchLeaderboard(activeTab); }, [activeTab, fetchLeaderboard]);

  const getChar = (id: string) => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[4];
  const maskAddr = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "60px 20px" }}>
      <h1 style={{ fontSize: 32, fontWeight: 900, letterSpacing: "0.15em", color: "#fbbf24", textShadow: "2px 2px 0 #92400e", marginBottom: 8, textAlign: "center" }}>
        GLOBAL ARENA
      </h1>
      <p style={{ fontSize: 12, color: "#64748b", letterSpacing: "0.15em", marginBottom: 32 }}>RANKINGS</p>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 32, background: "rgba(15,23,42,0.9)", borderRadius: 8, padding: 4, border: "1px solid #1e293b" }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "8px 20px", borderRadius: 6, fontSize: 12, fontWeight: 700,
              letterSpacing: "0.08em", cursor: "pointer", transition: "all 0.15s",
              fontFamily: "'Courier New', monospace",
              background: activeTab === tab.id ? "rgba(251,191,36,0.15)" : "transparent",
              border: activeTab === tab.id ? "1px solid #fbbf24" : "1px solid transparent",
              color: activeTab === tab.id ? "#fbbf24" : "#64748b",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div style={{ maxWidth: 750, width: "100%" }}>
        {/* Header */}
        <div style={{
          display: "grid", gridTemplateColumns: "50px 1fr 80px 60px 70px 80px",
          padding: "12px 16px", borderBottom: "2px solid #334155",
          fontSize: 10, color: "#64748b", letterSpacing: "0.1em",
        }}>
          <div>#</div>
          <div>PLAYER</div>
          <div style={{ textAlign: "center" }}>RANK</div>
          <div style={{ textAlign: "center" }}>WINS</div>
          <div style={{ textAlign: "center" }}>STREAK</div>
          <div style={{ textAlign: "center" }}>ACC%</div>
        </div>

        {loading && (
          <div style={{ padding: 40, textAlign: "center", color: "#64748b", fontSize: 14 }}>
            Loading...
          </div>
        )}

        {!loading && leaders.length === 0 && (
          <div style={{ padding: 40, textAlign: "center", color: "#475569", fontSize: 14 }}>
            No players yet. Enter the arena!
          </div>
        )}

        {leaders.map((l) => {
          const ch = getChar(l.favoriteChar);
          const isCurrentPlayer = address && l.address.toLowerCase() === address.toLowerCase();
          return (
            <div key={l.rank} style={{
              display: "grid", gridTemplateColumns: "50px 1fr 80px 60px 70px 80px",
              padding: "14px 16px", borderBottom: "1px solid #1e293b",
              background: isCurrentPlayer ? "rgba(168,85,247,0.08)" : l.rank <= 3 ? "rgba(251,191,36,0.04)" : "transparent",
              borderLeft: isCurrentPlayer ? "3px solid #a855f7" : "3px solid transparent",
              alignItems: "center",
            }}>
              <div style={{
                fontSize: 18, fontWeight: 900,
                color: l.rank === 1 ? "#fbbf24" : l.rank === 2 ? "#94a3b8" : l.rank === 3 ? "#b45309" : "#475569",
              }}>
                {String(l.rank).padStart(2, "0")}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 14, color: ch.colors.accent }}>{ch.name[0]}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: ch.colors.accent }}>{maskAddr(l.address)}</div>
                  <div style={{ fontSize: 10, color: "#475569" }}>{ch.name}</div>
                </div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: l.rankLabel?.includes("LEGEND") ? "#fbbf24" : l.rankLabel?.includes("DIAMOND") ? "#22d3ee" : l.rankLabel?.includes("GOLD") ? "#f59e0b" : l.rankLabel?.includes("SILVER") ? "#94a3b8" : "#b45309" }}>
                  {l.rankLabel ?? "BRONZE V"}
                </div>
                <div style={{ fontSize: 9, color: "#475569" }}>{l.rankPoints ?? 500} RP</div>
              </div>
              <div style={{ textAlign: "center", fontSize: 16, fontWeight: 900, color: "#10b981" }}>{l.pvpWins ?? l.totalWins}</div>
              <div style={{ textAlign: "center", fontSize: 14, color: "#f59e0b", fontWeight: 700 }}>{l.longestStreak}</div>
              <div style={{ textAlign: "center", fontSize: 14, color: "#a855f7" }}>{l.accuracy}%</div>
            </div>
          );
        })}
      </div>

      <button
        onClick={() => fetchLeaderboard(activeTab)}
        style={{
          marginTop: 24, background: "transparent", border: "2px solid #334155", borderRadius: 6,
          padding: "8px 20px", color: "#94a3b8", fontSize: 12, letterSpacing: "0.1em",
          cursor: "pointer", fontFamily: "'Courier New', monospace",
        }}
      >
        REFRESH
      </button>
    </div>
  );
}
