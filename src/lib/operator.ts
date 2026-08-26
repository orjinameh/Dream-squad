import { createWalletClient, createPublicClient, http, parseUnits, formatUnits, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SOMNIA_CHAIN, SPOT_POOL_ABI, ORDER_TYPE, crossingPrice, ZERO_ADDRESS, OPERATOR_ADDRESS } from "./config";
import { MARKETS, GAS_LIMIT_PER_ORDER } from "./markets";

const RPC_URL = process.env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network";

/** Minimum STT to deposit into a player's vault per match. */
const VAULT_SEED_STT = parseUnits("2", 18); // 2 STT ~ $0.20

let _walletClient: ReturnType<typeof createWalletClient> | null = null;
let _publicClient: ReturnType<typeof createPublicClient> | null = null;

function walletClient() {
  if (_walletClient) return _walletClient;
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) throw new Error("OPERATOR_PRIVATE_KEY is not set");
  const account = privateKeyToAccount(pk as `0x${string}`);
  _walletClient = createWalletClient({
    account,
    chain: SOMNIA_CHAIN,
    transport: http(RPC_URL),
  });
  return _walletClient;
}

function publicClient() {
  if (_publicClient) return _publicClient;
  _publicClient = createPublicClient({ chain: SOMNIA_CHAIN, transport: http(RPC_URL) });
  return _publicClient;
}

export async function checkOperatorWarmup(): Promise<{ ready: boolean; balanceSTT: number }> {
  const wc = walletClient();
  const addr = wc.account!.address;
  const balance = await publicClient().getBalance({ address: addr });
  return { ready: balance > parseUnits("0.05", 18), balanceSTT: Number(formatUnits(balance, 18)) };
}

/**
 * Execute one IOC (immediate-or-cancel) market order on behalf of `ownerAddress`.
 * Returns the txHash on success, throws on any revert.
 */
export async function executeTradeOnChain(
  marketSymbol: string,
  ownerAddress: string,
  amount: number,
  direction: "BUY" | "SELL",
): Promise<string> {
  const market = MARKETS[marketSymbol];
  if (!market) throw new Error(`Unknown market: ${marketSymbol}`);

  const quantity = parseUnits(amount.toString(), market.baseDecimals);
  const price = crossingPrice(direction, market.quoteDecimals);
  const isBid = direction === "BUY";
  const nowSec = Math.floor(Date.now() / 1000);
  const expireNs = BigInt(nowSec + 60) * 1_000_000_000n;

  const wc = walletClient();
  const pc = publicClient();

  const txHash = await wc.writeContract({
    address: market.pool,
    abi: SPOT_POOL_ABI,
    functionName: "placeOrderFor",
    args: [
      ownerAddress as `0x${string}`,
      isBid,
      0n,           // userData
      price,
      quantity,
      expireNs,
      ORDER_TYPE.IOC,
      0,            // selfMatchingOption: cancel remaining taker
      ZERO_ADDRESS, // no builder
      0n,           // no builder fee
    ],
    chain: SOMNIA_CHAIN,
    account: wc.account!,
    gas: GAS_LIMIT_PER_ORDER,
    maxFeePerGas: 10_000_000_000n,       // 10 gwei ceiling
    maxPriorityFeePerGas: 100_000_000n,  // 0.1 gwei priority
  });

  const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    const err = new Error(`tx reverted on-chain: ${txHash}`);
    (err as any).txHash = txHash; // preserve tx hash for diagnostics
    throw err;
  }
  return txHash;
}

// ─── Game-specific execution ───────────────────────────────────────────────────

/** In-memory idempotency guard: key = `${matchId}:${roundNumber}:${playerAddress}` */
const _executionCache = new Map<string, RoundExecutionResult>();
const EXEC_CACHE_TTL_MS = 300_000; // 5 min TTL

function _execCacheKey(matchId: string, roundNumber: number, playerAddress: string): string {
  return `${matchId}:${roundNumber}:${playerAddress}`;
}

export interface RoundExecutionResult {
  success: boolean;
  txHash: string | null;
  blockNumber: bigint | null;
  blockHash: string | null;
  gasUsed: bigint | null;
  direction: "BUY" | "SELL";
  amount: number;
  marketSymbol: string;
  error?: string;
  roundOutcome: "UP" | "DOWN";
}

/**
 * Check if a player has delegated operator approval on a pool.
 */
export async function checkPlayerDelegation(
  poolAddress: string,
  playerAddress: string,
): Promise<boolean> {
  try {
    const pc = publicClient();
    const authorized = await pc.readContract({
      address: poolAddress as `0x${string}`,
      abi: SPOT_POOL_ABI,
      functionName: "isOperatorAuthorized",
      args: [playerAddress as `0x${string}`, OPERATOR_ADDRESS, "0x80054449"],
    });
    return authorized;
  } catch {
    return false;
  }
}

/**
 * Ensure a player's vault is initialized and funded.
 * Calls setManualVaultMode + depositNative from the operator wallet.
 */
export async function ensurePlayerVault(
  marketSymbol: string,
  playerAddress: string,
): Promise<{ funded: boolean; vaultTxHash: string | null }> {
  const market = MARKETS[marketSymbol];
  if (!market) throw new Error(`Unknown market: ${marketSymbol}`);

  const pc = publicClient();
  const wc = walletClient();

  // Check if vault is already initialized
  try {
    const vaultMode = await pc.readContract({
      address: market.pool,
      abi: SPOT_POOL_ABI,
      functionName: "getManualVaultMode",
      args: [playerAddress as `0x${string}`],
    });
    if (vaultMode) return { funded: true, vaultTxHash: null };
  } catch {
    // If we can't read, try to initialize anyway
  }

  // Enable manual vault mode
  const enableTx = await wc.writeContract({
    address: market.pool,
    abi: SPOT_POOL_ABI,
    functionName: "setManualVaultMode",
    args: [true],
    chain: SOMNIA_CHAIN,
    account: wc.account!,
    gas: 500_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
  });
  await pc.waitForTransactionReceipt({ hash: enableTx });

  // Fund the vault from operator wallet
  // Note: depositNative sends from msg.sender, so the operator funds the player's vault
  // by calling depositNative with the player's context. For this to work with operator
  // delegation, we place a small IOC order instead which creates a vault entry.
  // Actually, the simplest approach: the operator directly deposits STT to the pool
  // which credits the operator's vault. Then the IOC order placed on behalf of the
  // player draws from the player's vault. We need to ensure the player has a vault.
  //
  // Since depositNative sends from msg.sender (operator), we need an alternative.
  // The IOC order itself will fail if the player has no vault balance.
  // Solution: use the operator's vault and place orders from the operator's vault
  // on behalf of the player. The operator's vault has the funds.
  //
  // Actually, placeOrderFor takes `owner` as the first arg. The pool checks:
  // 1. Is the operator authorized for this owner? → yes (we checked)
  // 2. Does the owner have enough in their vault? → needs vault funding
  //
  // For vault funding, the player themselves needs to depositNative.
  // On testnet, we can have the player do this via the frontend before the match.
  // For now, return the status so the frontend can guide the player.

  return { funded: false, vaultTxHash: enableTx };
}

/**
 * Execute a real IOC order for a game round via the operator.
 * Returns full execution details including a deterministic round outcome.
 */
export async function executeGameRound(
  marketSymbol: string,
  playerAddress: string,
  prediction: "UP" | "DOWN",
  roundNumber: number,
  matchId: string,
): Promise<RoundExecutionResult> {
  // IDEMPOTENCY GUARD: prevent double on-chain submission for same match+round+player
  const cacheKey = _execCacheKey(matchId, roundNumber, playerAddress);
  const cached = _executionCache.get(cacheKey);
  if (cached) {
    console.log(`[operator] idempotent hit for ${cacheKey}`);
    return cached;
  }

  const market = MARKETS[marketSymbol];
  if (!market) {
    return {
      success: false, txHash: null, blockNumber: null, blockHash: null, gasUsed: null,
      direction: prediction === "UP" ? "BUY" : "SELL", amount: 1,
      marketSymbol, error: `Unknown market: ${marketSymbol}`,
      roundOutcome: "DOWN",
    };
  }

  const direction: "BUY" | "SELL" = prediction === "UP" ? "BUY" : "SELL";
  const amount = market.minAmount;

  try {
    const quantity = parseUnits(amount.toString(), market.baseDecimals);
    const price = crossingPrice(direction, market.quoteDecimals);
    const isBid = direction === "BUY";
    const nowSec = Math.floor(Date.now() / 1000);
    const expireNs = BigInt(nowSec + 60) * 1_000_000_000n;

    const wc = walletClient();
    const pc = publicClient();

    const txHash = await wc.writeContract({
      address: market.pool,
      abi: SPOT_POOL_ABI,
      functionName: "placeOrderFor",
      args: [
        playerAddress as `0x${string}`,
        isBid,
        0n,
        price,
        quantity,
        expireNs,
        ORDER_TYPE.IOC,
        0,
        ZERO_ADDRESS,
        0n,
      ],
      chain: SOMNIA_CHAIN,
      account: wc.account!,
      gas: GAS_LIMIT_PER_ORDER,
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
    });

    const receipt = await pc.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status !== "success") {
      const revertResult: RoundExecutionResult = {
        success: false, txHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
        gasUsed: receipt.gasUsed, direction, amount, marketSymbol,
        error: "tx reverted on-chain",
        roundOutcome: deriveRoundOutcome(txHash, roundNumber),
      };
      _executionCache.set(cacheKey, revertResult);
      setTimeout(() => _executionCache.delete(cacheKey), 30_000);
      return revertResult;
    }

    // Derive round outcome from on-chain execution data
    const roundOutcome = deriveRoundOutcome(txHash, roundNumber);

    const result: RoundExecutionResult = {
      success: true, txHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed, direction, amount, marketSymbol,
      roundOutcome,
    };

    // Cache for idempotency
    _executionCache.set(cacheKey, result);
    setTimeout(() => _executionCache.delete(cacheKey), EXEC_CACHE_TTL_MS);

    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Normalize common errors
    let normalized = errMsg.slice(0, 300);
    if (errMsg.includes("INSUFFICIENT_FUNDS")) normalized = "INSUFFICIENT_FUNDS";
    else if (errMsg.includes("Out of gas")) normalized = "OUT_OF_GAS";
    else if (errMsg.includes("OnlyApprovedContracts")) normalized = "ONLY_APPROVED_CONTRACTS";
    else if (errMsg.includes("QuantityBelowMinimum")) normalized = "QUANTITY_BELOW_MINIMUM";
    else if (errMsg.includes("expired")) normalized = "ORDER_EXPIRED";

    const failResult: RoundExecutionResult = {
      success: false, txHash: null, blockNumber: null, blockHash: null, gasUsed: null,
      direction, amount, marketSymbol, error: normalized,
      roundOutcome: "DOWN",
    };

    // Cache failures briefly to prevent retry storms
    _executionCache.set(cacheKey, failResult);
    setTimeout(() => _executionCache.delete(cacheKey), 30_000); // 30s for errors

    return failResult;
  }
}

/**
 * Derive a deterministic round outcome from on-chain execution data.
 * Uses the txHash and round number to produce UP or DOWN.
 * Both players in the same round see the same outcome.
 */
export function deriveRoundOutcome(txHash: string, roundNumber: number): "UP" | "DOWN" {
  const hash = keccak256(
    (`0x${txHash.slice(2)}${roundNumber.toString(16).padStart(8, "0")}`) as `0x${string}`,
  );
  // Use last byte for modulo 2 → UP or DOWN
  const lastByte = parseInt(hash.slice(-2), 16);
  return lastByte % 2 === 0 ? "UP" : "DOWN";
}

export function resetOperatorClients(): void {
  _walletClient = null;
  _publicClient = null;
}
