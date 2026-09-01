#!/usr/bin/env tsx
/**
 * Phase 5 — End-to-End Testnet Verification (self-contained)
 *
 * Uses mongodb-memory-server so no external MongoDB is needed.
 * Tests the critical path: delegation -> vault funding -> batch creation ->
 * atomic worker claim -> IOC order execution -> on-chain verification.
 *
 * All transactions hit Shannon testnet for real.
 */
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from "viem";
import { SOMNIA_CHAIN, SPOT_POOL_ABI, OPERATOR_REGISTRY_ABI, OPERATOR_ADDRESS, SELECTORS } from "../src/lib/config";
import { MARKETS, GAS_LIMIT_PER_ORDER } from "../src/lib/markets";

const REGISTRY    = "0x15C7e8CE38F021c5b45d098AaD788f63090bF20A" as `0x${string}`;
const RPC         = "https://dream-rpc.somnia.network";
const EXPLORER    = "https://shannon-explorer.somnia.network/tx/";
const MAX_FEE     = 10_000_000_000n;
const MAX_PRIO    = 100_000_000n;

// Funding account that grants the operator order-delegation. NEVER hardcode a
// private key — read it from the environment (see .env.example).
const fundKey = process.env.FUND_KEY;
if (!fundKey) throw new Error("FUND_KEY is not set (funding account for operator delegation)");
const fundAccount = (await import("viem/accounts")).privateKeyToAccount(fundKey as `0x${string}`);
const FUND_ADDR = fundAccount.address as `0x${string}`;

const market = MARKETS["SOMI:USDso"];
const publicClient = createPublicClient({ transport: http(RPC) });
const fundWallet   = createWalletClient({ account: fundAccount, chain: SOMNIA_CHAIN, transport: http(RPC) });

const txUrls: string[] = [];

function log(msg: string) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }
function explorer(hash: string) { return `${EXPLORER}${hash}`; }

// ─── Pre-flight ───────────────────────────────────────────────────────────────
async function preflight() {
  log("=== Phase 5 E2E Testnet Verification ===");
  const [opBal, fundBal] = await Promise.all([
    publicClient.getBalance({ address: OPERATOR_ADDRESS as `0x${string}` }),
    publicClient.getBalance({ address: FUND_ADDR }),
  ]);
  log(`Operator (${OPERATOR_ADDRESS.slice(0,8)}...): ${formatUnits(opBal, 18)} STT`);
  log(`Fund     (${FUND_ADDR.slice(0,8)}...):       ${formatUnits(fundBal, 18)} STT`);
  if (opBal < parseUnits("0.05", 18)) throw new Error("Operator wallet underfunded (<0.05 STT)");
  if (fundBal < parseUnits("0.1", 18)) throw new Error("Fund wallet underfunded (<0.1 STT)");
  log("");
}

// ─── Step 1: Grant operator delegation ────────────────────────────────────────
async function grantDelegation() {
  log("STEP 1: Grant operator delegation");

  const authed = await publicClient.readContract({
    address: market.pool, abi: SPOT_POOL_ABI,
    functionName: "isOperatorAuthorized",
    args: [FUND_ADDR, OPERATOR_ADDRESS as `0x${string}`, SELECTORS.placeOrderFor],
  });
  if (authed) { log("  -> Already authorized"); return; }

  const hash = await fundWallet.writeContract({
    address: REGISTRY, abi: OPERATOR_REGISTRY_ABI,
    functionName: "setOperatorApprovalForPool",
    args: [market.pool, OPERATOR_ADDRESS as `0x${string}`, [SELECTORS.placeOrderFor, SELECTORS.cancelOrderFor] as `0x${string}`[], true],
    maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: MAX_PRIO,
  });
  txUrls.push(hash);
  log(`  -> tx: ${explorer(hash)}`);
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  log(`  -> status=${rc.status} gas=${rc.gasUsed}`);
  if (rc.status !== "success") throw new Error("Delegation reverted");
}

// ─── Step 2: Manual-vault mode + deposit ──────────────────────────────────────
async function fundVault() {
  log("STEP 2: Vault mode + deposit SOMI");

  const vaultMode = await publicClient.readContract({
    address: market.pool, abi: SPOT_POOL_ABI,
    functionName: "getManualVaultMode", args: [FUND_ADDR],
  });
  if (!vaultMode) {
    const h = await fundWallet.writeContract({
      address: market.pool, abi: SPOT_POOL_ABI,
      functionName: "setManualVaultMode", args: [true],
      maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: MAX_PRIO,
    });
    txUrls.push(h);
    const rc = await publicClient.waitForTransactionReceipt({ hash: h });
    log(`  -> setManualVaultMode: ${rc.status} (tx: ${explorer(h)})`);
    if (rc.status !== "success") throw new Error("setManualVaultMode reverted");
  } else {
    log("  -> Vault mode already on");
  }

  // Try to deposit 0.5 SOMI (smaller amount to avoid reverts if vault is near capacity).
  // If it reverts (e.g. vault already has funds from Phase 1), we skip gracefully.
  try {
    const depositAmt = parseUnits("0.5", market.baseDecimals);
    const h2 = await fundWallet.writeContract({
      address: market.pool, abi: SPOT_POOL_ABI,
      functionName: "depositNative", value: depositAmt,
      maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: MAX_PRIO,
    });
    txUrls.push(h2);
    const rc2 = await publicClient.waitForTransactionReceipt({ hash: h2 });
    log(`  -> depositNative(0.5 SOMI): ${rc2.status} gas=${rc2.gasUsed} (tx: ${explorer(h2)})`);
    if (rc2.status !== "success") log("  -> deposit reverted, proceeding (vault may already have funds)");
  } catch (e: any) {
    log(`  -> depositNative skipped: ${(e?.shortMessage || e?.message || "").slice(0, 120)}`);
    log("  -> proceeding with existing vault balance (Phase 1 or prior deposit)");
  }
}

// ─── Step 3+4: Create batch + trade in DB ─────────────────────────────────────
async function createBatchInDb(): Promise<string> {
  log("STEP 3: Create batch + trades in DB");

  const { Batch } = await import("../src/db/models/Batch");
  const { Trade } = await import("../src/db/models/Trade");
  const { User }  = await import("../src/db/models/User");

  const now = new Date();
  // 70-second window: enough time for Step 4 to join, short enough for quick E2E
  const closesAt = new Date(now.getTime() + 70_000);
  const batchId = `e2e-somi-${Date.now().toString(36)}`;

  // Upsert user
  await User.findByIdAndUpdate(FUND_ADDR, { $setOnInsert: { _id: FUND_ADDR, operatorAuthorized: true, vaultInitialized: true } }, { upsert: true });

  // Create batch
  await Batch.create({
    _id: batchId, creatorAddress: FUND_ADDR, market: "SOMI:USDso", direction: "SELL",
    status: "OPEN", opensAt: now, closesAt, totalPool: 0,
  });

  // Single trade: 1 SOMI SELL order (matches Phase 1 proven direction — vault has SOMI base)
  await Trade.create({ batchId, userAddress: FUND_ADDR, amount: 1, status: "PENDING" });
  await Batch.updateOne({ _id: batchId }, { $inc: { totalPool: 1 } });

  log(`  -> batchId: ${batchId}`);
  log(`  -> Single trade: 1 SOMI SELL order (vault has SOMI from Phase 1)`);
  log(`  -> closesAt: ${closesAt.toISOString()} (${Math.round((closesAt.getTime() - now.getTime()) / 1000)}s from now)`);
  return batchId;
}

// ─── Step 5: Wait for expiry ──────────────────────────────────────────────────
async function waitForExpiry(batchId: string) {
  log("STEP 4: Waiting for batch to expire...");
  const { Batch } = await import("../src/db/models/Batch");

  for (let i = 0; i < 50; i++) {
    const b = await Batch.findById(batchId).lean();
    if (!b) throw new Error("Batch disappeared");
    const remaining = b.closesAt.getTime() - Date.now();
    if (remaining <= 0) {
      log(`  -> Expired! (${b.status})`);
      return;
    }
    if (i % 5 === 0) log(`  -> ${Math.ceil(remaining / 1000)}s remaining...`);
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("Timeout waiting for expiry");
}

// ─── Step 6: Worker claim + execute ───────────────────────────────────────────
async function executeWorker(): Promise<{ succeeded: number; failed: number }> {
  log("STEP 5: Worker — claim batch + execute IOC orders");

  const { claimNextBatch } = await import("../src/lib/worker");
  const { executeTradeOnChain } = await import("../src/lib/operator");
  const { Batch } = await import("../src/db/models/Batch");
  const { Trade } = await import("../src/db/models/Trade");

  const batch = await claimNextBatch();
  if (!batch) {
    log("  -> No batch claimable");
    return { succeeded: 0, failed: 0 };
  }
  log(`  -> Claimed: ${batch._id} (market=${batch.market} dir=${batch.direction})`);

  const trades = await Trade.find({ batchId: batch._id, status: "PENDING" }).sort({ createdAt: 1 });
  log(`  -> ${trades.length} trade(s) to execute sequentially`);

  let succeeded = 0;
  let failed = 0;

  for (const trade of trades) {
    try {
      log(`  -> [${trade.userAddress.slice(0,8)}...] ${trade.amount} ${batch.direction} ${batch.market}`);
      const txHash = await executeTradeOnChain(batch.market, trade.userAddress, trade.amount, batch.direction as "BUY" | "SELL");
      txUrls.push(txHash);
      await Trade.findByIdAndUpdate(trade._id, { $set: { status: "EXECUTED", txHash, executedAt: new Date() } });
      log(`  -> SUCCESS: ${explorer(txHash)}`);
      succeeded++;
    } catch (err: any) {
      const msg = (err?.shortMessage || err?.message || String(err)).slice(0, 400);
      // Extract tx hash even if the receipt shows reverted
      const txHash = err?.txHash || msg.match(/0x[a-fA-F0-9]{64}/)?.[0];
      if (txHash && !txUrls.includes(txHash)) txUrls.push(txHash);
      await Trade.findByIdAndUpdate(trade._id, { $set: { status: "FAILED", errorMessage: msg, ...(txHash ? { txHash } : {}) } });
      log(`  -> FAILED: ${msg}`);
      if (txHash) log(`  -> Reverted tx on explorer: ${explorer(txHash)}`);
      failed++;
    }
  }

  const status = failed === trades.length ? "FAILED" : "EXECUTED";
  await Batch.findByIdAndUpdate(batch._id, { $set: { status } });
  log(`  -> Batch final: ${status}`);
  return { succeeded, failed };
}

// ─── Step 7: Verify ───────────────────────────────────────────────────────────
async function verify(batchId: string) {
  log("STEP 6: Verification");

  const { Trade } = await import("../src/db/models/Trade");
  const { Batch } = await import("../src/db/models/Batch");

  const batch = await Batch.findById(batchId).lean();
  const trades = await Trade.find({ batchId }).lean();

  log(`  -> Batch status: ${batch?.status}`);
  log(`  -> Total pool: ${batch?.totalPool}`);

  for (const t of trades) {
    log(`  -> ${t.userAddress.slice(0,8)}... | ${t.amount} SOMI | ${t.status} | tx: ${t.txHash ?? "n/a"} | err: ${t.errorMessage ?? "none"}`);
  }

  // Log all transaction URLs for manual verification
  if (txUrls.length > 0) {
    log("");
    log("  All on-chain transactions:");
    for (const h of txUrls) log(`    ${explorer(h)}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Start in-memory MongoDB
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  await mongoose.connect(mongo.getUri());
  log("MongoDB: in-memory connected");
  log("");

  await preflight();
  await grantDelegation();
  await fundVault();
  const batchId = await createBatchInDb();
  await waitForExpiry(batchId);
  const result = await executeWorker();
  await verify(batchId);

  log("");
  log("=== PHASE 5 E2E COMPLETE ===");
  log(`Executed: ${result.succeeded} | Failed: ${result.failed}`);
  log(`Explorer: https://shannon-explorer.somnia.network`);
  log("");

  await mongoose.disconnect();
  await mongo.stop();
}

main().catch(async (err) => {
  console.error("\nE2E FAILED:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
