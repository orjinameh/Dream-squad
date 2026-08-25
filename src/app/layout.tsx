import type { Metadata } from "next";
import { Providers } from "./providers";
import { WalletButton } from "@/components/WalletButton";

export const metadata: Metadata = { title: "DreamSquad" };

const NAV_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "16px 24px",
  borderBottom: "1px solid #1e1e2e",
};

const LOGO_STYLE: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
  letterSpacing: "-0.02em",
  color: "#00d4ff",
  textDecoration: "none",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#08080f", color: "#e0e0e0", fontFamily: "system-ui, -apple-system, sans-serif" }}>
        <Providers>
          <nav style={NAV_STYLE}>
            <a href="/" style={LOGO_STYLE}>DreamSquad</a>
            <WalletButton />
          </nav>
          {children}
        </Providers>
      </body>
    </html>
  );
}
