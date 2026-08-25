"use client";

import { useState, useCallback, useEffect } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connectAsync, connectors, isPending: connectPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const [localError, setLocalError] = useState<string | null>(null);
  const [hasEthereum, setHasEthereum] = useState(false);

  useEffect(() => {
    setHasEthereum(typeof window !== "undefined" && Boolean(window.ethereum));
  }, []);

  const handleConnect = useCallback(async () => {
    setLocalError(null);

    if (!window.ethereum) {
      setLocalError("No wallet found. Install MetaMask to continue.");
      return;
    }

    // Try wagmi connectors first
    if (connectors.length > 0) {
      const injected = connectors.find(
        (c) => c.id === "injected" || c.name.toLowerCase().includes("injected"),
      );
      const target = injected || connectors[0];
      try {
        await connectAsync({ connector: target });
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("rejected") || msg.includes("denied")) return;
        // If wagmi fails, fall through to raw ethereum
        console.warn("[DreamSquad] wagmi connect failed, trying raw ethereum:", msg);
      }
    }

    // Fallback: raw window.ethereum request
    try {
      await window.ethereum!.request({ method: "eth_requestAccounts" });
      // Force page reload so wagmi picks up the connected state
      window.location.reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("rejected")) {
        setLocalError(msg.slice(0, 100));
      }
    }
  }, [connectAsync, connectors]);

  if (isConnected) {
    const short = `${address!.slice(0, 6)}...${address!.slice(-4)}`;
    return (
      <button
        onClick={() => disconnect()}
        style={{
          background: "rgba(15, 23, 42, 0.6)",
          border: "1px solid rgba(6, 182, 212, 0.3)",
          borderRadius: 10,
          padding: "8px 16px",
          color: "#00d4ff",
          cursor: "pointer",
          fontFamily: "'SF Mono', 'Fira Code', monospace",
          fontSize: 13,
          backdropFilter: "blur(8px)",
          transition: "all 0.2s",
        }}
      >
        {short}
      </button>
    );
  }

  const errorMsg = localError || connectError?.message;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <button
        onClick={handleConnect}
        disabled={connectPending}
        style={{
          background: connectPending ? "rgba(51,65,85,0.5)" : "linear-gradient(135deg, #06b6d4, #10b981)",
          border: "none",
          borderRadius: 10,
          padding: "8px 20px",
          color: connectPending ? "#64748b" : "#08080f",
          fontWeight: 700,
          cursor: connectPending ? "wait" : "pointer",
          fontSize: 13,
          boxShadow: connectPending ? "none" : "0 0 20px rgba(6, 182, 212, 0.3)",
          transition: "all 0.25s",
        }}
      >
        {connectPending ? "Connecting..." : "Connect Wallet"}
      </button>
      {errorMsg && (
        <span style={{ fontSize: 11, color: "#f43f5e", maxWidth: 200, textAlign: "right" }}>
          {errorMsg.slice(0, 80)}
        </span>
      )}
    </div>
  );
}
