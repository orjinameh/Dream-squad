"use client";

import { type ReactNode, useState } from "react";
import {
  RainbowKitProvider,
  connectorsForWallets,
  darkTheme,
} from "@rainbow-me/rainbowkit";
import { injectedWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { WagmiProvider, createConfig } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SOMNIA_CHAIN } from "@/lib/config";
import { ecHttpTransport } from "@/lib/ec/config";
import "@rainbow-me/rainbowkit/styles.css";

// Both connect paths:
//  - injectedWallet  → desktop browser-extension MetaMask. Needs no project ID;
//    `window.ethereum` drives the native popup for approve/stake/withdraw.
//  - walletConnectWallet → mobile + extension pairing via WalletConnect relay.
//    THIS requires a real WalletConnect Cloud project ID; if it's missing the
//    relay can't deliver prompts. Set
//    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID in the deployed env to a real ID.
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

function makeConfig() {
  const connectors = connectorsForWallets(
    [
      { groupName: "Browser", wallets: [injectedWallet] },
      ...(projectId ? [{ groupName: "Mobile / WalletConnect", wallets: [walletConnectWallet] }] : []),
    ],
    { appName: "DreamDuel", projectId: projectId || "dreamduel" },
  );
  return createConfig({
    connectors,
    chains: [SOMNIA_CHAIN],
    // Fallback across the testnet mirror RPCs so a rate-limited primary never
    // blocks wallet gas estimation (approve popups) or balance reads.
    transports: { [SOMNIA_CHAIN.id]: ecHttpTransport() },
    ssr: true,
  });
}

export function Providers({ children }: { children: ReactNode }) {
  // Per-request QueryClient + wagmi config: a module-scope singleton would
  // share cached queries across SSR users (cross-user bleed + memory leak).
  const [queryClient] = useState(() => new QueryClient());
  const [config] = useState(makeConfig);
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: "#a855f7",
            accentColorForeground: "white",
            borderRadius: "medium",
            fontStack: "system",
            overlayBlur: "small",
          })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
