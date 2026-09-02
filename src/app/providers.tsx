"use client";

import { type ReactNode } from "react";
import {
  RainbowKitProvider,
  connectorsForWallets,
  darkTheme,
} from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { WagmiProvider, createConfig, http } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SOMNIA_CHAIN } from "@/lib/config";
import "@rainbow-me/rainbowkit/styles.css";

// Browser-extension injected wallet (MetaMask) only. WalletConnect is excluded:
// it needs a valid WalletConnect Cloud project ID which isn't configured in the
// deployed env (falls back to a placeholder), and without it the WalletConnect
// relayer can't deliver the signing/approval prompt — so transactions were only
// visible if the user opened MetaMask and signed manually. With the injected
// connector, MetaMask's native popup fires for every approve/stake/withdraw.
const connectors = connectorsForWallets(
  [{ groupName: "Browser Wallet", wallets: [injectedWallet] }],
  { appName: "DreamDuel", projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "dreamduel" },
);

const config = createConfig({
  connectors,
  chains: [SOMNIA_CHAIN],
  transports: { [SOMNIA_CHAIN.id]: http() },
  ssr: true,
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
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
