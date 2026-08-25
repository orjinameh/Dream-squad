"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
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

const btn = (active: boolean): React.CSSProperties => ({
  background: active ? "#00d4ff" : "#1a1a2e",
  color: active ? "#08080f" : "#888",
  border: active ? "1px solid #00d4ff" : "1px solid #333",
  borderRadius: 8,
  padding: "10px 16px",
  fontWeight: 600,
  cursor: "pointer",
  fontSize: 14,
});

const pill = (active: boolean): React.CSSProperties => ({
  ...btn(active),
  borderRadius: 20,
  padding: "8px 18px",
  fontSize: 13,
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
  const txHash = useWaitForTransactionReceipt;

  const baseAmount = dollarsToBase(+amount || 0, market);

  const ensureDelegation = useCallback(async () => {
    if (!address) throw new Error("wallet not connected");
    const pool = MARKETS[market].pool;
    // Read authorization (view call, no gas)
    const res = await fetch(
      `/api/syndicates/check-delegation?pool=${pool}&owner=${address}`,
    );
    const data = await res.json();
    if (data.authorized) return;

    setPhase("delegating");
    const hash = await writeContractAsync({
      address: OPERATOR_REGISTRY_ADDRESS,
      abi: OPERATOR_REGISTRY_ABI,
      functionName: "setOperatorApprovalForPool",
      args: [pool, OPERATOR_ADDRESS, [SELECTORS.placeOrderFor, SELECTORS.cancelOrderFor], true],
    });
    // Wait for receipt via polling (wagmi's useWaitForTransactionReceipt needs the hash in state,
    // so we poll manually here to keep the flow self-contained).
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
          creatorAddress: address,
          market,
          direction,
          durationSeconds: duration,
          amount: baseAmount,
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

  return (
    <main style={{ maxWidth: 520, margin: "0 auto", padding: "40px 24px" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 28 }}>New Syndicate</h1>

      {/* Market */}
      <label style={labelStyle}>Market</label>
      <div style={row}>
        {MARKET_KEYS.map((m) => (
          <button key={m} style={btn(market === m)} onClick={() => setMarket(m)}>
            {m.split(":")[0]}
          </button>
        ))}
      </div>

      {/* Direction */}
      <label style={labelStyle}>Direction</label>
      <div style={row}>
        {(["BUY", "SELL"] as const).map((d) => (
          <button key={d} style={btn(direction === d)} onClick={() => setDirection(d)}>
            {d}
          </button>
        ))}
      </div>

      {/* Stake */}
      <label style={labelStyle}>
        Stake (USDso) &mdash; ~{baseAmount} {market.split(":")[0]}
      </label>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        {PILLS.map((p) => (
          <button key={p} style={pill(amount === String(p))} onClick={() => setAmount(String(p))}>
            ${p}
          </button>
        ))}
      </div>
      <input
        type="number"
        min={0}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        style={inputStyle}
      />

      {/* Duration */}
      <label style={labelStyle}>Lobby Duration</label>
      <div style={row}>
        {DURATIONS.map((d) => (
          <button key={d.value} style={btn(duration === d.value)} onClick={() => setDuration(d.value)}>
            {d.label}
          </button>
        ))}
      </div>

      <div style={{ background: "#1a1508", borderRadius: 8, padding: 12, border: "1px solid #332200", marginTop: 24 }}>
        <p style={{ fontSize: 12, color: "#ff8800" }}>
          Before creating a syndicate, ensure your DreamDEX vault has at least {MARKETS[market]?.minAmount ?? 1} {market.split(":")[0]} deposited. Orders below the pool minimum will revert on-chain. Use the pool&apos;s deposit function or send tokens directly to your vault.
        </p>
      </div>

      {/* CTA */}
      <button
        onClick={handleCreate}
        disabled={busy || !isConnected}
        style={{
          width: "100%",
          marginTop: 32,
          padding: "16px 0",
          background: busy ? "#333" : "#00d4ff",
          color: busy ? "#888" : "#08080f",
          border: "none",
          borderRadius: 10,
          fontWeight: 700,
          fontSize: 16,
          cursor: busy ? "wait" : "pointer",
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
        <p style={{ marginTop: 16, color: "#ff4444", fontSize: 13 }}>{error}</p>
      )}
    </main>
  );
}

const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, color: "#888", marginTop: 20, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" };
const row: React.CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap" };
const inputStyle: React.CSSProperties = { width: "100%", padding: "10px 14px", background: "#1a1a2e", border: "1px solid #333", borderRadius: 8, color: "#e0e0e0", fontSize: 16, outline: "none", boxSizing: "border-box" as const };
