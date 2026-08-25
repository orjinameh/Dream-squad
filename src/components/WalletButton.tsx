"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending: connectPending } = useConnect();
  const { disconnect } = useDisconnect();

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

  const handleConnect = () => {
    const injected = connectors.find((c) => c.id === "injected" || c.name === "Injected");
    const target = injected || connectors[0];
    if (!target) {
      console.error("[DreamSquad] No connectors available. Is MetaMask installed?");
      return;
    }
    try {
      connect({ connector: target });
    } catch (err) {
      console.error("[DreamSquad] Connect failed:", err);
    }
  };

  return (
    <button
      onClick={handleConnect}
      disabled={connectPending}
      style={{
        background: connectPending ? "#333" : "linear-gradient(135deg, #06b6d4, #10b981)",
        border: "none",
        borderRadius: 10,
        padding: "8px 20px",
        color: "#08080f",
        fontWeight: 700,
        cursor: connectPending ? "wait" : "pointer",
        fontSize: 13,
        boxShadow: connectPending ? "none" : "0 0 20px rgba(6, 182, 212, 0.3)",
        transition: "all 0.25s",
      }}
    >
      {connectPending ? "Connecting..." : "Connect Wallet"}
    </button>
  );
}
