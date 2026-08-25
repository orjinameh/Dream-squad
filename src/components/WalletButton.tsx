"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    const short = `${address.slice(0, 6)}...${address.slice(-4)}`;
    return (
      <button
        onClick={() => disconnect()}
        style={{
          background: "rgba(15, 23, 42, 0.6)",
          border: "1px solid rgba(6, 182, 212, 0.3)",
          borderRadius: 10, padding: "8px 16px", color: "#00d4ff",
          cursor: "pointer", fontFamily: "monospace", fontSize: 13,
          backdropFilter: "blur(8px)",
        }}
      >
        {short}
      </button>
    );
  }

  return (
    <button
      onClick={() => connect({ connector: connectors[0] })}
      style={{
        background: "linear-gradient(135deg, #06b6d4, #10b981)",
        border: "none", borderRadius: 10, padding: "8px 20px",
        color: "#08080f", fontWeight: 700, cursor: "pointer", fontSize: 13,
        boxShadow: "0 0 20px rgba(6, 182, 212, 0.3)",
      }}
    >
      Connect Wallet
    </button>
  );
}
