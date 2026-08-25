"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected) {
    const short = `${address!.slice(0, 6)}...${address!.slice(-4)}`;
    return (
      <button
        onClick={() => disconnect()}
        style={{
          background: "#1a1a2e",
          border: "1px solid #333",
          borderRadius: 8,
          padding: "8px 14px",
          color: "#00d4ff",
          cursor: "pointer",
          fontFamily: "monospace",
          fontSize: 13,
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
        background: "#00d4ff",
        border: "none",
        borderRadius: 8,
        padding: "8px 18px",
        color: "#08080f",
        fontWeight: 600,
        cursor: "pointer",
        fontSize: 13,
      }}
    >
      Connect Wallet
    </button>
  );
}
