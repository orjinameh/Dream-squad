#!/usr/bin/env tsx
/**
 * Phase 3 entry point — polls MongoDB for OPEN batches whose timer has expired,
 * claims one atomically, executes all pending trades sequentially via operator
 * delegation, and writes back tx hashes.
 *
 * Usage:
 *   MONGODB_URI=mongodb://... OPERATOR_PRIVATE_KEY=0x... npm run worker
 *
 * The operator wallet MUST be pre-funded with ≥ 0.05 STT on Shannon testnet
 * (Phase 1 learned: Somnia rejects zero-balance senders).
 */

import { startWorker, createProductionDeps } from "../lib/worker";

startWorker(createProductionDeps()).catch((err) => {
  console.error("[executor] fatal:", err);
  process.exit(1);
});
