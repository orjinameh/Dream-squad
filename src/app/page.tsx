"use client";

export default function Home() {
  return (
    <main style={{
      maxWidth: 720, margin: "0 auto", padding: "100px 24px 80px",
      textAlign: "center", position: "relative",
    }}>
      {/* Title glow */}
      <div style={{
        position: "absolute", top: 60, left: "50%", transform: "translateX(-50%)",
        width: 300, height: 120, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(6,182,212,0.2) 0%, transparent 70%)",
        filter: "blur(40px)", pointerEvents: "none",
      }} />

      <h1 style={{
        fontSize: 56, fontWeight: 900, letterSpacing: "-0.04em",
        lineHeight: 1.1, marginBottom: 16, position: "relative",
        background: "linear-gradient(135deg, #06b6d4 0%, #10b981 50%, #06b6d4 100%)",
        WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
      }}>
        DreamSquad
      </h1>

      <p style={{
        fontSize: 20, color: "rgba(148, 163, 184, 0.9)", lineHeight: 1.7,
        marginBottom: 16, maxWidth: 540, marginLeft: "auto", marginRight: "auto",
        letterSpacing: "0.01em",
      }}>
        Pool capital with friends. Execute synchronized trades on DreamDEX via
        backend operator delegation.
      </p>

      <p style={{
        fontSize: 15, color: "rgba(100, 116, 139, 0.8)", lineHeight: 1.6,
        marginBottom: 48, maxWidth: 480, marginLeft: "auto", marginRight: "auto",
      }}>
        No custody. No custom contracts. Just vibes and on-chain execution.
      </p>

      {/* Feature pills */}
      <div style={{
        display: "flex", justifyContent: "center", gap: 12,
        marginBottom: 48, flexWrap: "wrap",
      }}>
        {["Zero Custody", "Operator Delegation", "Social Execution"].map((f) => (
          <span key={f} style={{
            padding: "8px 18px", borderRadius: 20, fontSize: 13, fontWeight: 600,
            color: "#06b6d4",
            background: "rgba(6, 182, 212, 0.08)",
            border: "1px solid rgba(6, 182, 212, 0.2)",
            letterSpacing: "0.02em",
          }}>
            {f}
          </span>
        ))}
      </div>

      {/* CTA */}
      <a href="/create" style={{
        display: "inline-block",
        background: "linear-gradient(135deg, #06b6d4, #10b981)",
        color: "#06060e",
        fontWeight: 800, fontSize: 17, letterSpacing: "-0.01em",
        padding: "16px 40px", borderRadius: 14,
        textDecoration: "none",
        boxShadow: "0 0 30px rgba(6, 182, 212, 0.3), 0 4px 20px rgba(0,0,0,0.3)",
        transition: "all 0.3s",
      }}>
        Start a Syndicate
      </a>

      {/* Bottom stats */}
      <div style={{
        display: "flex", justifyContent: "center", gap: 48,
        marginTop: 80, opacity: 0.5,
      }}>
        {[
          { label: "Network", value: "Somnia Testnet" },
          { label: "Protocol", value: "DreamDEX Spot" },
          { label: "Execution", value: "IOC Market Orders" },
        ].map((s) => (
          <div key={s.label} style={{ textAlign: "center" }}>
            <div style={{ fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
              {s.label}
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#94a3b8" }}>
              {s.value}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
