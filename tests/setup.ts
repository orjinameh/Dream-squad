/**
 * Global test setup. `__ROUND_TIME__` shortens match rounds so unit/integration
 * tests advance rounds quickly without waiting real seconds.
 */
(globalThis as any).__ROUND_TIME__ = 1;

// Load the real operator key + RPC config only for the opt-in on-chain test so
// the big spendy integration test can drive the real relay/escrow. Next loads
// .env at app runtime; tests run outside Next so we parse it minimally here.
if (process.env.RUN_ONCHAIN === "1") {
  const fs = await import("node:fs");
  const path = await import("node:path");
  for (const file of [".env.local", ".env"]) {
    try {
      const p = path.resolve(process.cwd(), file);
      if (!fs.existsSync(p)) continue;
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const key = m[1];
        const val = m[2].trim().replace(/^["']|["']$/g, "");
        if (key === "OPERATOR_PRIVATE_KEY" && !process.env[key]) process.env[key] = val;
        if (key === "EC_RPC_URL" && !process.env[key]) process.env[key] = val;
      }
    } catch {
      /* ignore unreadable env file */
    }
  }
}

export {};
