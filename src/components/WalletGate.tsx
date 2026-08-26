"use client";

import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { SOMNIA_CHAIN } from "@/lib/config";

export interface WalletInfo {
  address: `0x${string}` | undefined;
  shortAddress: string;
  isConnected: boolean;
  isOnSomnia: boolean;
}

export function useWalletInfo(): WalletInfo {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const shortAddress = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";
  return {
    address: address ?? undefined,
    shortAddress,
    isConnected,
    isOnSomnia: chainId === SOMNIA_CHAIN.id,
  };
}

export function WalletGate({ children }: { children: React.ReactNode }) {
  const wallet = useWalletInfo();

  if (!wallet.isConnected) {
    return (
      <div style={{
        minHeight: "100vh", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", padding: "40px 20px",
      }}>
        <div style={{
          fontSize: 36, fontWeight: 900, letterSpacing: "0.15em",
          color: "#fbbf24", textShadow: "2px 2px 0 #92400e", marginBottom: 16,
          textAlign: "center",
        }}>
          CONNECT YOUR WALLET
        </div>
        <p style={{ fontSize: 13, color: "#64748b", letterSpacing: "0.1em", marginBottom: 32, textAlign: "center", maxWidth: 400 }}>
          Connect your wallet on Somnia Testnet to enter the arena.
        </p>
        <ConnectButton />
      </div>
    );
  }

  if (!wallet.isOnSomnia) {
    return <WrongNetwork />;
  }

  return <>{children}</>;
}

function WrongNetwork() {
  const { switchChain } = useSwitchChain();

  return (
    <div style={{
      minHeight: "100vh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", padding: "40px 20px",
    }}>
      <div style={{
        fontSize: 36, fontWeight: 900, letterSpacing: "0.15em",
        color: "#f59e0b", textShadow: "2px 2px 0 #92400e", marginBottom: 16,
        textAlign: "center",
      }}>
        WRONG NETWORK
      </div>
      <p style={{ fontSize: 13, color: "#64748b", letterSpacing: "0.1em", marginBottom: 32, textAlign: "center", maxWidth: 400 }}>
        Switch to Somnia Testnet to play.
      </p>
      <button
        onClick={() => switchChain({ chainId: SOMNIA_CHAIN.id })}
        style={{
          background: "linear-gradient(135deg, #b45309, #f59e0b)",
          border: "none", borderRadius: 8, padding: "14px 36px",
          color: "#fff", fontWeight: 900, fontSize: 16, letterSpacing: "0.08em",
          cursor: "pointer", fontFamily: "'Courier New', monospace",
          boxShadow: "0 4px 15px rgba(245,158,11,0.3)",
        }}
      >
        SWITCH TO SOMNIA TESTNET
      </button>
    </div>
  );
}
