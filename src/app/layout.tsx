import type { Metadata } from "next";
import { Providers } from "./providers";
import { WalletButton } from "@/components/WalletButton";

export const metadata: Metadata = {
  title: "DreamSquad",
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
            }}>DREAMSQUAD</a>
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <a href="/" style={{ fontSize: 12, color: "#94a3b8", letterSpacing: "0.1em", textDecoration: "none" }}>ARENA</a>
              <a href="/leaderboard" style={{ fontSize: 12, color: "#94a3b8", letterSpacing: "0.1em", textDecoration: "none" }}>RANKS</a>
              <a href="/create" style={{ fontSize: 12, color: "#64748b", letterSpacing: "0.1em", textDecoration: "none" }}>SYNDICATES</a>
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
