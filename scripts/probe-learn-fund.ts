/* eslint-disable no-console */
/**
 * LEARN the real funding path end-to-end: approve → mintSet → placeBinaryOrder.
 *
 *   npx tsx scripts/probe-learn-fund.ts
 *
 * Runs each step live against the soonest BTC window and reports what works,
 * so the game's staking logic uses the venue's ACTUAL mechanics.
 */
import { createPublicClient, createWalletClient, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { EC_ADDRESSES, EC_CHAIN, EC_COLLATERAL_DECIMALS, EC_INDEXER_URL, EC_RPC_WS_URL, ecHttpTransport } from "../src/lib/ec/config";

async function loadEnv(): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...process.env };
  const { existsSync, readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  for (const file of [".env.local", ".env"]) {
    try {
      const p = resolve(process.cwd(), file);
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const key = m[1];
        const val = m[2].trim().replace(/^["']|["']$/g, "");
        if (!out[key]) out[key] = val;
      }
    } catch { /* ignore */ }
  }
  return out;
}

const ERC20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)", "function balanceOf(address owner) view returns (uint256)"]);
const POOL = parseAbi([
  "function mintSet(address builder, address referrer, uint256 amount) payable",
  "function getBinaryPoolParams() view returns ((address collateralToken, address market, address outcomeToken, uint256 yesId, uint256 noId, uint256 oneCollateral, uint256 setBacking, address feeRecipient, uint256 makerFeeBpsTimes1k, uint256 takerFeeBpsTimes1k, uint256 maxBuilderFeeBpsTimes1k, uint256 settlementFeeBpsTimes1k, address settlement, uint64 marketNonce, bool finalized))",
]);

(async () => {
  const env = await loadEnv();
  const pk = env.OPERATOR_PRIVATE_KEY;
  if (!pk) { console.log("OPERATOR_PRIVATE_KEY missing"); process.exit(1); }
  process.env.OPERATOR_PRIVATE_KEY = pk;
  const op = privateKeyToAccount(pk as `0x${string}`);
  const pc = createPublicClient({ chain: EC_CHAIN, transport: ecHttpTransport() });
  const wc = createWalletClient({ account: op, chain: EC_CHAIN, transport: ecHttpTransport() });
  const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
  const DEC = 10n ** BigInt(EC_COLLATERAL_DECIMALS);
  const tUSDC = EC_ADDRESSES.collateral as `0x${string}`;

  const exchange = new SomniaMarkets({ indexerUrl: EC_INDEXER_URL, chain: EC_CHAIN, wsRpcUrl: EC_RPC_WS_URL, addresses: EC_ADDRESSES });
  await exchange.loadMarkets(true);
  const now = Math.floor(Date.now() / 1000);
  const live = Object.values(exchange.markets)
    .filter((m) => m.type === "binary" && /^BTC-/.test(m.symbol) && !m.symbol.includes("-0-"))
    .map((m) => ({ m, expiry: Number((m.info as any)?.expiry ?? 0) }))
    .filter((x) => x.expiry > now)
    .sort((a, b) => a.expiry - b.expiry);
  const target = live.find((x) => x.expiry > now + 30) ?? live[0];
  if (!target) { console.log("no live BTC window"); process.exit(0); }
  const oc = await exchange.client.getMarketOnchain(target.m.id as `0x${string}`);
  const pool = oc.pool as `0x${string}`;
  console.log(`window  ${target.m.symbol}  pool=${pool}  closes in ~${target.expiry - now}s`);

  const bal = await pc.readContract({ address: tUSDC, abi: ERC20, functionName: "balanceOf", args: [op.address] });
  console.log(`operator tUSDC=${Number(bal) / 1e6}  approval=ONLY-IF-NEEDED`);

  // 1) approve the pool to spend tUSDC (mintSet pays from this).
  const setAmt = 1n * DEC; // 1 tUSDC — operator's balance is tiny
  if (setAmt > bal) { console.log("insufficient tUSDC"); process.exit(1); }
  const approveHash = await wc.writeContract({ address: tUSDC, abi: ERC20, functionName: "approve", args: [pool, setAmt * 10n], chain: EC_CHAIN, account: op });
  await pc.waitForTransactionReceipt({ hash: approveHash, timeout: 60_000 });
  console.log(`approve  tx=${approveHash}  spender=${pool}  amt=${setAmt * 10n}`);

  // 2) mint the set (5 tUSDC collateral → 1 Up + 1 Down ERC-6909 tokens).
  try {
    const setHash = await wc.writeContract({ address: pool, abi: POOL, functionName: "mintSet", args: [ZERO, ZERO, setAmt], chain: EC_CHAIN, account: op, gas: 5_000_000n });
    await pc.waitForTransactionReceipt({ hash: setHash, timeout: 60_000 });
    console.log(`mintSet  tx=${setHash}  amount=${setAmt} tUSDC → 1 Up + 1 Down set minted`);
  } catch (e) {
    console.log("mintSet FAILED:", String(e).slice(0, 240));
    process.exit(1);
  }

  // 3) placeBinaryOrderFor simulate — buy YES vs the current book.
  const book = await exchange.fetchOrderBook(target.m.symbol, 1);
  const ask = book.asks[0]?.[0];
  if (!ask) { console.log("no ask — one-sided book; retry later"); process.exit(0); }
  const tick = 0.0015;
  const yesPrice = Math.min(0.999, Math.floor((ask + Math.max(ask * 0.03, 0.015)) / tick) * tick);
  const qty = 1_000_000n; // 1 YES token (~1 tUSDC notional)
  const expireNs = BigInt(target.expiry) * 1_000_000_000n;
  const ORDER_ABI = parseAbi([
    "function placeBinaryOrderFor(address owner, uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable",
  ]);
  const args = [op.address, 0, BigInt(Math.round(yesPrice * 1_000_000)), qty, expireNs, 2, 0, ZERO, 0n, 0n] as const;
  try {
    await pc.simulateContract({ address: pool, abi: ORDER_ABI, functionName: "placeBinaryOrderFor", args, account: op.address });
    console.log(`place    SIMULATES OK → BUY_YES kind=0 price=${yesPrice} qty=${qty}`);
  } catch (e) {
    console.log("place    SIMULATE FAILED:", String(e).slice(0, 300));
  }
})().catch((e) => { console.error("probe crashed:", e); process.exit(1); });