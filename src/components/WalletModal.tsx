"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";

export function WalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { isConnected } = useAccount();

  if (!open) return null;
  if (isConnected) {
    onClose();
    return null;
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)",
    }} onClick={onClose}>
      <div style={{
        background: "#0f172a", border: "2px solid #a855f7", borderRadius: 12,
        padding: "32px 40px", maxWidth: 420, width: "90%", textAlign: "center",
        boxShadow: "0 0 40px rgba(168,85,247,0.2)",
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{
          fontSize: 20, fontWeight: 900, letterSpacing: "0.12em",
          color: "#fbbf24", marginBottom: 8,
        }}>
          CONNECT WALLET
        </div>
        <p style={{ fontSize: 12, color: "#64748b", letterSpacing: "0.05em", marginBottom: 24, lineHeight: 1.6 }}>
          Connect your wallet on Somnia Testnet to enter the arena.
        </p>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <ConnectButton />
        </div>
        <button
          onClick={onClose}
          style={{
            marginTop: 20, background: "none", border: "none",
            color: "#64748b", fontSize: 12, cursor: "pointer",
            letterSpacing: "0.1em",
          }}
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}
