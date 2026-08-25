"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useWriteContract } from "wagmi";
import {
  OPERATOR_ADDRESS,
  OPERATOR_REGISTRY_ADDRESS,
  SELECTORS,
  OPERATOR_REGISTRY_ABI,
  dollarsToBase,
} from "@/lib/config";
import { MARKETS } from "@/lib/markets";

const DURATIONS = [
  { label: "60s", value: 60 },
  { label: "3m", value: 180 },
  { label: "5m", value: 300 },
] as const;

const PILLS = [50, 100, 250, 500] as const;
const MARKET_KEYS = Object.keys(MARKETS) as string[];

const pillStyle = (active: boolean): React.CSSProperties => ({
  padding: "10px 22px", borderRadius: 20, fontSize: 14, fontWeight: 600,
  cursor: "pointer",
  color: active ? "#06b6d4" : "rgba(148, 163, 184, 0.7)",
  background: active ? "rgba(6, 182, 212, 0.1)" : "rgba(30, 41, 59, 0.5)",
  border: active ? "1px solid rgba(6, 182, 212, 0.5)" : "1px solid rgba(51, 65, 85, 0.5)",
  boxShadow: active ? "0 0 20px rgba(6, 182, 212, 0.2)" : "none",
  transition: "all 0.2s",
});

const directionPill = (active: boolean, dir: string): React.CSSProperties => ({
  ...pillStyle(active),
  borderRadius: 10,
  padding: "12px 28px",
  fontSize: 15,
  fontWeight: 700,
  color: active
    ? dir === "BUY" ? "#10b981" : "#f43f5e"
    : "rgba(148, 163, 184, 0.7)",
  background: active
    ? dir === "BUY" ? "rgba(16, 185, 129, 0.1)" : "rgba(244, 63, 94, 0.1)"
    : "rgba(30, 41, 59, 0.5)",
  border: active
    ? dir === "BUY" ? "1px solid rgba(16, 185, 129, 0.5)" : "1px solid rgba(244, 63, 94, 0.5)"
    : "1px solid rgba(51, 65, 85, 0.5)",
  boxShadow: active
    ? dir === "BUY" ? "0 0 20px rgba(16, 185, 129, 0.2)" : "0 0 20px rgba(244, 63, 94, 0.2)"
    : "none",
});

export default function CreatePage() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const [market, setMarket] = useState<string>(MARKET_KEYS[0]);
  const [direction, setDirection] = useState<"BUY" | "SELL">("BUY");
  const [amount, setAmount] = useState<string>("100");
  const [duration, setDuration] = useState<number>(180);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "delegating" | "creating">("idle");

  const { writeContractAsync } = useWriteContract();
  const baseAmount = dollarsToBase(+amount || 0, market);

  const ensureDelegation = useCallback(async () => {
    if (!address) throw new Error("wallet not connected");
    const pool = MARKETS[market].pool;
    const res = await fetch(`/api/syndicates/check-delegation?pool=${pool}&owner=${address}`);
    const data = await res.json();
    if (data.authorized) return;
    setPhase("delegating");
    const hash = await writeContractAsync({
      address: OPERATOR_REGISTRY_ADDRESS,
      abi: OPERATOR_REGISTRY_ABI,
      functionName: "setOperatorApprovalForPool",
      args: [pool, OPERATOR_ADDRESS, [SELECTORS.placeOrderFor, SELECTORS.cancelOrderFor], true],
    });
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const rc = await fetch(`/api/syndicates/tx-status?hash=${hash}`).then((r) => r.json());
      if (rc.confirmed) return;
    }
    throw new Error("delegation tx timed out");
  }, [address, market, writeContractAsync]);

  const handleCreate = useCallback(async () => {
    if (!isConnected || !address) return;
    setError(null);
    setBusy(true);
    try {
      await ensureDelegation();
      setPhase("creating");
      const res = await fetch("/api/syndicates/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          creatorAddress: address, market, direction,
          durationSeconds: duration, amount: baseAmount,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "create failed");
      router.push(`/squad/${data.batchId}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setBusy(false);
    }
  }, [isConnected, address, ensureDelegation, market, direction, duration, baseAmount, router]);

  const baseSymbol = market.split(":")[0];

  return (
    <main style={{ maxWidth: 600, margin: "0 auto", padding: "48px 24px" }}>
      <div style={{
        background: "rgba(15, 23, 42, 0.6)",
        backdropFilter: "blur(20px)",
        border: "1px solid rgba(51, 65, 85, 0.5)",
        borderRadius: 20, padding: "40px 36px",
        boxShadow: "0 25px 60px rgba(0, 0, 0, 0.5), 0 0 40px rgba(6, 182, 212, 0.03)",
      }}>
        <h1 style={{
          fontSize: 28, fontWeight: 800, letterSpacing: "-0.03em",
          marginBottom: 32,
          background: "linear-gradient(135deg, #e2e8f0, #94a3b8)",
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
        }}>
          New Syndicate
        </h1>

        {/* Market */}
        <label style={labelStyle}>Market</label>
        <div style={row}>
          {MARKET_KEYS.map((m) => (
            <button key={m} style={pillStyle(market === m)} onClick={() => setMarket(m)}>
              {m.split(":")[0]}
            </button>
          ))}
        </div>

        {/* Direction */}
        <label style={labelStyle}>Direction</label>
        <div style={row}>
          {(["BUY", "SELL"] as const).map((d) => (
            <button key={d} style={directionPill(direction === d, d)} onClick={() => setDirection(d)}>
              {d}
            </button>
          ))}
        </div>

        {/* Stake */}
        <label style={labelStyle}>
          Stake (USDso) &mdash; ~{baseAmount} {baseSymbol}
        </label>
        <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          {PILLS.map((p) => (
            <button key={p} style={pillStyle(amount === String(p))} onClick={() => setAmount(String(p))}>
              ${p}
            </button>
          ))}
        </div>
        <input
          type="number" min={0} value={amount}
          onChange={(e) => setAmount(e.target.value)}
          style={inputStyle}
        />

        {/* Duration */}
        <label style={labelStyle}>Lobby Duration</label>
        <div style={row}>
          {DURATIONS.map((d) => (
            <button key={d.value} style={pillStyle(duration === d.value)} onClick={() => setDuration(d.value)}>
              {d.label}
            </button>
          ))}
        </div>

        {/* Vault warning */}
        <div style={{
          marginTop: 28, padding: "14px 16px", borderRadius: 12,
          background: "rgba(251, 146, 60, 0.06)",
          border: "1px solid rgba(251, 146, 60, 0.2)",
        }}>
          <p style={{ fontSize: 13, color: "#fb923c", margin: 0, lineHeight: 1.5 }}>
            Ensure your vault has at least {MARKETS[market]?.minAmount ?? 1} {baseSymbol} deposited.
            Orders below the pool minimum will revert on-chain.
          </p>
        </div>

        {/* CTA */}
        <button
          onClick={handleCreate}
          disabled={busy || !isConnected}
          style={{
            width: "100%", marginTop: 28, padding: "16px 0",
            border: "none", borderRadius: 14, fontWeight: 800, fontSize: 16,
            letterSpacing: "-0.01em", cursor: busy ? "wait" : "pointer",
            background: busy ? "rgba(51, 65, 85, 0.5)" : "linear-gradient(135deg, #06b6d4, #10b981)",
            color: busy ? "#64748b" : "#06060e",
            boxShadow: busy ? "none" : "0 0 30px rgba(6, 182, 212, 0.3), 0 4px 20px rgba(0,0,0,0.3)",
            transition: "all 0.25s",
          }}
        >
          {!isConnected
            ? "Connect Wallet First"
            : phase === "delegating"
              ? "Approving Operator..."
              : phase === "creating"
                ? "Creating Syndicate..."
                : "Start a Syndicate"}
        </button>

        {error && (
          <p style={{ marginTop: 16, color: "#f43f5e", fontSize: 13, textAlign: "center" }}>{error}</p>
        )}
      </div>
    </main>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 12, color: "#64748b", marginTop: 24, marginBottom: 8,
  textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600,
};
const row: React.CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap" };
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "12px 16px",
  background: "rgba(15, 23, 42, 0.5)",
  border: "1px solid rgba(51, 65, 85, 0.5)", borderRadius: 10,
  color: "#e2e8f0", fontSize: 16, outline: "none",
  boxSizing: "border-box" as const,
  transition: "border-color 0.2s",
};
