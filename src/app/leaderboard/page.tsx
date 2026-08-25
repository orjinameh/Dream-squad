"use client";

import { useState, useEffect } from "react";
import { CHARACTERS } from "@/game/characters";

interface Leader {
  rank: number;
  address: string;
  totalWins: number;
  totalMatches: number;
  correctPredictions: number;
  longestStreak: number;
  favoriteChar: string;
  accuracy: number;
}

export default function LeaderboardPage() {
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/leaderboard")
      .then((r) => r.json())
      .then((d) => { setLeaders(d.leaderboard ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const getChar = (id: string) => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[4];
  const maskAddr = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "60px 20px" }}>
      <h1 style={{ fontSize: 32, fontWeight: 900, letterSpacing: "0.15em", color: "#fbbf24", textShadow: "2px 2px 0 #92400e", marginBottom: 8, textAlign: "center" }}>
        {"\uD83C\uDFC6"} HALL OF DREAMERS
      </h1>
      <p style={{ fontSize: 12, color: "#64748b", letterSpacing: "0.15em", marginBottom: 40 }}>TOP PREDICTORS</p>

      <div style={{ maxWidth: 700, width: "100%" }}>
        {/* Header */}
        <div style={{
          display: "grid", gridTemplateColumns: "60px 1fr 80px 80px 80px",
          padding: "12px 16px", borderBottom: "2px solid #334155",
          fontSize: 11, color: "#64748b", letterSpacing: "0.1em",
        }}>
          <div>RANK</div>
          <div>PLAYER</div>
          <div style={{ textAlign: "center" }}>WINS</div>
          <div style={{ textAlign: "center" }}>MATCHES</div>
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
          return (
            <div key={l.rank} style={{
              display: "grid", gridTemplateColumns: "60px 1fr 80px 80px 80px",
              padding: "14px 16px", borderBottom: "1px solid #1e293b",
              background: l.rank <= 3 ? "rgba(251,191,36,0.04)" : "transparent",
              alignItems: "center",
            }}>
              <div style={{
                fontSize: 18, fontWeight: 900,
                color: l.rank === 1 ? "#fbbf24" : l.rank === 2 ? "#94a3b8" : l.rank === 3 ? "#b45309" : "#475569",
              }}>
                {String(l.rank).padStart(2, "0")}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 16 }}>{ch.name[0]}</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: ch.colors.accent }}>{maskAddr(l.address)}</div>
                  <div style={{ fontSize: 10, color: "#475569" }}>
                    {ch.name} | Streak: {l.longestStreak}
                  </div>
                </div>
              </div>
              <div style={{ textAlign: "center", fontSize: 16, fontWeight: 900, color: "#10b981" }}>{l.totalWins}</div>
              <div style={{ textAlign: "center", fontSize: 14, color: "#94a3b8" }}>{l.totalMatches}</div>
              <div style={{ textAlign: "center", fontSize: 14, color: "#a855f7" }}>{l.accuracy}%</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
