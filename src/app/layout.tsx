import type { Metadata } from "next";
import { Providers } from "./providers";
import { WalletButton } from "@/components/WalletButton";

export const metadata: Metadata = {
  title: "DreamDuel",
  description: "Retro 1v1 prediction battles on Somnia",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{`
          *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
          html, body { min-height: 100vh; }
          body {
            color: #e0e0e0;
            font-family: 'Courier New', monospace;
            background: #080810;
            overflow-x: hidden;
          }
        `}</style>
      </head>
      <body>
        <Providers>
          <nav style={{
            position: "sticky", top: 0, zIndex: 50,
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 24px",
            borderBottom: "2px solid #1e293b",
            background: "rgba(8,8,16,0.95)",
          }}>
            <a href="/" style={{
              fontSize: 18, fontWeight: 900, letterSpacing: "0.15em",
              color: "#fbbf24", textShadow: "1px 1px 0 #92400e",
              textDecoration: "none",
            }}>DREAMDUEL</a>
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "#22d3ee",
              background: "rgba(34,211,238,0.1)", border: "1px solid rgba(34,211,238,0.4)",
              padding: "2px 8px", borderRadius: 999,
            }}>
              BUILD {process.env.NEXT_PUBLIC_BUILD_TAG ?? "ec-oracle-36a5ad0"}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <a href="/" style={{ fontSize: 12, color: "#94a3b8", letterSpacing: "0.1em", textDecoration: "none" }}>ARENA</a>
              <a href="/leaderboard" style={{ fontSize: 12, color: "#94a3b8", letterSpacing: "0.1em", textDecoration: "none" }}>RANKS</a>
              <WalletButton />
            </div>
          </nav>
          <div style={{ position: "relative", zIndex: 1 }}>
            {children}
          </div>
        </Providers>
      </body>
    </html>
  );
}
