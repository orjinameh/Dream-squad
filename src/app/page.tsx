"use client";

const FEATURES = [
  {
    icon: "\u{1FA99}",
    title: "Multi-Token Sweep",
    desc: "Select any token mix or sweep micro-balances from your Somnia wallet.",
  },
  {
    icon: "\u26A1",
    title: "EIP-5792 Batching",
    desc: "Batch-approve and convert assets in a single wallet signature.",
  },
  {
    icon: "\u{1F3C6}",
    title: "Synchronized Execution",
    desc: "Relayers route aggregated liquidity to execute atomic prediction trades on DreamDEX.",
  },
] as const;

export default function Home() {
  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "100px 24px 80px" }}>
      {/* Hero */}
      <div style={{ textAlign: "center", marginBottom: 80, position: "relative" }}>
        <h1 style={{
          fontSize: 56, fontWeight: 900, letterSpacing: "-0.04em", lineHeight: 1.1,
          marginBottom: 20, position: "relative",
          background: "linear-gradient(135deg, #22d3ee, #c084fc, #d946ef)",
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
          filter: "drop-shadow(0 0 20px rgba(168,85,247,0.3))",
        }}>
          Funnel Multi-Token Conviction.
          <br />
          Execute on Somnia.
        </h1>

        <p style={{
          fontSize: 18, color: "rgba(224,231,239,0.65)", lineHeight: 1.7,
          maxWidth: 600, margin: "0 auto 40px",
        }}>
          Pledge custom tokens or sweep wallet dust. DreamSquad aggregates your
          chosen assets via EIP-5792 into synchronized, atomic trades on DreamDEX.
        </p>

        {/* Feature badges */}
        <div style={{
          display: "flex", justifyContent: "center", gap: 12,
          marginBottom: 48, flexWrap: "wrap",
        }}>
          {[
            "\u{1FA99} Multi-Token & Dust Pledges",
            "\u26A1 EIP-5792 Batch Swaps",
            "\u{1F3AF} Atomic DreamDEX Execution",
          ].map((b) => (
            <span key={b} style={{
              padding: "8px 18px", borderRadius: 20, fontSize: 13, fontWeight: 600,
              color: "#a855f7",
              background: "rgba(168,85,247,0.08)",
              border: "1px solid rgba(147,51,234,0.25)",
            }}>
              {b}
            </span>
          ))}
        </div>

        {/* CTA */}
        <a href="/create" style={{
          display: "inline-block",
          background: "linear-gradient(135deg, #a855f7, #d946ef)",
          color: "#fff", fontWeight: 800, fontSize: 17, letterSpacing: "-0.01em",
          padding: "16px 44px", borderRadius: 14, textDecoration: "none",
          boxShadow: "0 0 30px rgba(168,85,247,0.35), 0 4px 20px rgba(0,0,0,0.4)",
          transition: "all 0.3s",
        }}>
          Start a Syndicate
        </a>
      </div>

      {/* 3-card grid */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        gap: 20,
      }}>
        {FEATURES.map((f) => (
          <div key={f.title} style={{
            background: "rgba(14,19,40,0.60)",
            backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
            border: "1px solid rgba(147,51,234,0.20)",
            borderRadius: 20, padding: "32px 28px",
            boxShadow: "0 0 25px rgba(168,85,247,0.12)",
            transition: "border-color 0.3s",
          }}>
            <div style={{ fontSize: 36, marginBottom: 16 }}>{f.icon}</div>
            <h3 style={{
              fontSize: 18, fontWeight: 700, margin: "0 0 10px",
              color: "#e2e8f0",
            }}>
              {f.title}
            </h3>
            <p style={{
              fontSize: 14, lineHeight: 1.6, margin: 0,
              color: "rgba(148,163,184,0.8)",
            }}>
              {f.desc}
            </p>
          </div>
        ))}
      </div>

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
            <div style={{
              fontSize: 12, color: "#64748b", textTransform: "uppercase",
              letterSpacing: "0.08em", marginBottom: 4,
            }}>
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
