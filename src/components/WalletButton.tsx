"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useConnectors, useDisconnect } from "wagmi";

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();
  const connectors = useConnectors();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const c = connectors[0];
      if (c) {
        const provider = await c.getProvider();
        setReady(!!provider);
      }
    })();
  }, [connectors]);

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
      disabled={!ready}
      onClick={() => connect({ connector: connectors[0] })}
      style={{
        background: ready ? "linear-gradient(135deg, #06b6d4, #10b981)" : "rgba(51,65,85,0.5)",
        border: "none", borderRadius: 10, padding: "8px 20px",
        color: ready ? "#08080f" : "#64748b",
        fontWeight: 700, cursor: ready ? "pointer" : "not-allowed", fontSize: 13,
        boxShadow: ready ? "0 0 20px rgba(6, 182, 212, 0.3)" : "none",
      }}
    >
      {ready ? "Connect Wallet" : "Loading..."}
    </button>
  );
}
