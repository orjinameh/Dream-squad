import type { Metadata } from "next";
import { Providers } from "./providers";
import { WalletButton } from "@/components/WalletButton";

export const metadata: Metadata = {
  title: "DreamSquad",
  description: "Social co-op prediction market on DreamDEX",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{`
          *, *::before, *::after { box-sizing: border-box; }
          html, body { margin: 0; padding: 0; min-height: 100vh; }
          body {
            color: #e0e7ef;
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            background: #060812;
            overflow-x: hidden;
          }
          a { color: inherit; text-decoration: none; }
          @keyframes orbDrift {
            0%, 100% { transform: translate(0, 0) scale(1); }
            33% { transform: translate(30px, -50px) scale(1.05); }
            66% { transform: translate(-20px, 20px) scale(0.95); }
          }
          @keyframes orbDrift2 {
            0%, 100% { transform: translate(0, 0) scale(1); }
            33% { transform: translate(-40px, 30px) scale(1.1); }
            66% { transform: translate(20px, -40px) scale(0.9); }
          }
        `}</style>
      </head>
      <body>
        {/* Fixed ambient glow orbs */}
        <div style={{
          pointerEvents: "none", position: "fixed", inset: 0, zIndex: 0,
          overflow: "hidden",
        }}>
          <div style={{
            position: "absolute", top: -160, left: "50%", transform: "translateX(-50%)",
            width: 700, height: 700, borderRadius: "50%",
            background: "radial-gradient(circle, rgba(147,51,234,0.20) 0%, transparent 70%)",
            filter: "blur(150px)", animation: "orbDrift 25s ease-in-out infinite",
          }} />
          <div style={{
            position: "absolute", top: "33%", left: -128,
            width: 500, height: 500, borderRadius: "50%",
            background: "radial-gradient(circle, rgba(6,182,212,0.15) 0%, transparent 70%)",
            filter: "blur(130px)", animation: "orbDrift2 30s ease-in-out infinite",
          }} />
        </div>

        <Providers>
          {/* Sticky nav */}
          <nav style={{
            position: "sticky", top: 0, zIndex: 50,
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "16px 24px",
            borderBottom: "1px solid rgba(147,51,234,0.2)",
            background: "rgba(9,13,31,0.70)",
            backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
          }}>
            <a href="/" style={{
              fontSize: 22, fontWeight: 900, letterSpacing: "-0.03em",
              background: "linear-gradient(135deg, #22d3ee, #a855f7, #d946ef)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
              filter: "drop-shadow(0 0 12px rgba(168,85,247,0.6))",
            }}>
              DreamSquad
            </a>

            <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
              <a href="/" style={{
                fontSize: 14, fontWeight: 500, color: "rgba(224,231,239,0.7)",
                transition: "color 0.2s",
              }}>Home</a>
              <a href="/create" style={{
                fontSize: 14, fontWeight: 500, color: "rgba(224,231,239,0.7)",
                transition: "color 0.2s",
              }}>Create Syndicate</a>
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
