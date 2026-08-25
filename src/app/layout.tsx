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
            color: #e0e0e0;
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            background: #06060e;
            overflow-x: hidden;
          }
          @keyframes meshShift {
            0%, 100% { transform: translate(0, 0) scale(1); }
            33% { transform: translate(30px, -50px) scale(1.05); }
            66% { transform: translate(-20px, 20px) scale(0.95); }
          }
          @keyframes meshShift2 {
            0%, 100% { transform: translate(0, 0) scale(1); }
            33% { transform: translate(-40px, 30px) scale(1.1); }
            66% { transform: translate(20px, -40px) scale(0.9); }
          }
        `}</style>
      </head>
      <body>
        {/* Gradient mesh background */}
        <div style={{
          position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none",
          overflow: "hidden",
        }}>
          <div style={{
            position: "absolute", top: "-20%", left: "15%",
            width: 600, height: 600, borderRadius: "50%",
            background: "radial-gradient(circle, rgba(6,182,212,0.12) 0%, transparent 70%)",
            filter: "blur(80px)",
            animation: "meshShift 20s ease-in-out infinite",
          }} />
          <div style={{
            position: "absolute", top: "30%", right: "-10%",
            width: 500, height: 500, borderRadius: "50%",
            background: "radial-gradient(circle, rgba(16,185,129,0.10) 0%, transparent 70%)",
            filter: "blur(80px)",
            animation: "meshShift2 25s ease-in-out infinite",
          }} />
          <div style={{
            position: "absolute", bottom: "-10%", left: "30%",
            width: 400, height: 400, borderRadius: "50%",
            background: "radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%)",
            filter: "blur(80px)",
            animation: "meshShift 30s ease-in-out infinite reverse",
          }} />
        </div>

        <Providers>
          <nav style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "18px 32px",
            borderBottom: "1px solid rgba(6, 182, 212, 0.08)",
            backdropFilter: "blur(12px)",
            background: "rgba(6, 6, 14, 0.5)",
            position: "sticky", top: 0, zIndex: 50,
          }}>
            <a href="/" style={{
              fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em",
              background: "linear-gradient(135deg, #06b6d4, #10b981)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
              textDecoration: "none",
            }}>DreamSquad</a>
            <WalletButton />
          </nav>
          <div style={{ position: "relative", zIndex: 1 }}>
            {children}
          </div>
        </Providers>
      </body>
    </html>
  );
}
