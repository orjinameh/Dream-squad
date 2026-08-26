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
  rankingScore: number;
}

export default function LeaderboardPage() {
  const { address } = useAccount();
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLeaderboard = useCallback(() => {
    setLoading(true);
    fetch("/api/leaderboard")
      .then((r) => r.json())
      .then((d) => { setLeaders(d.leaderboard ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { fetchLeaderboard(); }, [fetchLeaderboard]);

  const getChar = (id: string) => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[4];
  const maskAddr = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "60px 20px" }}>
      <h1 style={{ fontSize: 32, fontWeight: 900, letterSpacing: "0.15em", color: "#fbbf24", textShadow: "2px 2px 0 #92400e", marginBottom: 8, textAlign: "center" }}>
        HALL OF DREAMERS
      </h1>
      <p style={{ fontSize: 12, color: "#64748b", letterSpacing: "0.15em", marginBottom: 40 }}>TOP PREDICTORS</p>

      <div style={{ maxWidth: 750, width: "100%" }}>
        {/* Header */}
        <div style={{
          display: "grid", gridTemplateColumns: "50px 1fr 60px 60px 60px 60px 80px",
          padding: "12px 16px", borderBottom: "2px solid #334155",
          fontSize: 10, color: "#64748b", letterSpacing: "0.1em",
        }}>
          <div>#</div>
          <div>PLAYER</div>
          <div style={{ textAlign: "center" }}>WINS</div>
          <div style={{ textAlign: "center" }}>LOSSES</div>
          <div style={{ textAlign: "center" }}>MATCHES</div>
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
            No matches played yet. Enter the arena!
          </div>
        )}

        {leaders.map((l) => {
          const ch = getChar(l.favoriteChar);
          const isCurrentPlayer = address && l.address.toLowerCase() === address.toLowerCase();
          return (
            <div key={l.rank} style={{
              display: "grid", gridTemplateColumns: "50px 1fr 60px 60px 60px 60px 80px",
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
                  <div style={{ fontSize: 10, color: "#475569" }}>
                    {ch.name} | Score: {l.rankingScore}
                  </div>
                </div>
              </div>
              <div style={{ textAlign: "center", fontSize: 16, fontWeight: 900, color: "#10b981" }}>{l.totalWins}</div>
              <div style={{ textAlign: "center", fontSize: 14, color: "#ef4444" }}>{l.totalLosses ?? 0}</div>
              <div style={{ textAlign: "center", fontSize: 14, color: "#94a3b8" }}>{l.totalMatches}</div>
              <div style={{ textAlign: "center", fontSize: 14, color: "#f59e0b", fontWeight: 700 }}>{l.longestStreak}</div>
              <div style={{ textAlign: "center", fontSize: 14, color: "#a855f7" }}>{l.accuracy}%</div>
            </div>
          );
        })}
      </div>

      <button
        onClick={fetchLeaderboard}
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
