"use client";

import { createWalletClient, createPublicClient, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EC_CHAIN, ROUND_ESCROW_ADDRESS, EC_ADDRESSES, ecHttpTransport } from "@/lib/ec/config";
import { DREAMDUEL_ROUND_ESCROW_ABI } from "@/lib/ec/escrowAbi";
import { matchKey } from "@/lib/ec/matchKey";

/** tUSDC address (testnet collateral). */
const TUSDC_ADDRESS: `0x${string}` = (EC_ADDRESSES.testUsdc ?? EC_ADDRESSES.collateral)!;

/**
 * Ghost (ephemeral) wallet for a fight.
 *
 * Strategy (user-defined): instead of the connected primary wallet signing a
 * separate tUSDC transfer for EVERY round (7 popups), the front-end spins up a
 * brand-new random private key in browser memory (sessionStorage) at match
 * lobby. This ghost signs the per-round `stakeRound`/`withdraw` calls directly
 * with a raw viem account — NO wallet prompt, because it's a private key, not a
 * MetaMask/WalletConnect connector. The player funds the ghost ONCE via a single
 * `approve` (their only popup), the server relays the funds into the ghost, and
 * the ghost handles every round instantly in the background.
 *
 * SECURITY: the ghost private key lives only in the current tab's sessionStorage
 * and is destroyed when the tab/session ends. Funds in it are meant to float
 * only for the ~minutes of a single fight.
 */

const GHOST_PREFIX = "dreamduel_ghost_";

export interface GhostWallet {
  address: `0x${string}`;
  signStakeRound(args: { matchId: string; playerAddress: string; round: number; amount: bigint; entryPrice: bigint }): Promise<Hash>;
  signApproveEscrow(spender: `0x${string}`, amountRaw: bigint): Promise<Hash>;
  signWithdraw(matchId: string, playerAddress: string): Promise<Hash>;
  signTransfer(to: `0x${string}`, amountRaw: bigint): Promise<Hash>;
  ghostBalance(): Promise<bigint>;
  /** Remove this match's ghost key from sessionStorage (end of fight). */
  destroy(): void;
}

const TUSDC_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "faucet",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

/** Random 32-byte private key (CSPRNG). Validated to be in secp256k1 range by
 *  privateKeyToAccount at build time — no manual bit-twiddling that reduces
 *  entropy. */
function randomPrivateKey(): `0x${string}` {
  const bytes = new Uint8Array(32);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Server-side: Node.js crypto is always available in Next.js API routes.
    // This path should only be hit in edge cases (e.g. old browsers).
    throw new Error("[ghost] crypto.getRandomValues unavailable — cannot generate secure key");
  }
  return `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

function assertPrivateKey(pk: string): asserts pk is `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("[ghost] invalid stored key — clearing");
}

export function getOrCreateGhost(matchId: string): GhostWallet {
  if (typeof window === "undefined") throw new Error("[ghost] no window (SSR)");
  const storage = window.sessionStorage;
  const key = `${GHOST_PREFIX}${matchId}`;
  let pk = storage.getItem(key);
  if (pk) {
    try { assertPrivateKey(pk); }
    catch { storage.removeItem(key); pk = null; }
  }
  if (!pk) {
    pk = randomPrivateKey();
    // Validate before persisting (guarantees < secp256k1.n via viem).
    privateKeyToAccount(pk as `0x${string}`);
    storage.setItem(key, pk);
  }
  assertPrivateKey(pk);
  return buildGhost(pk, () => storage.removeItem(key));
}

/** Rebuild a ghost from an already-persisted key (SSR/navigation safe). */
export function loadGhost(matchId: string): GhostWallet | null {
  if (typeof window === "undefined") return null;
  const pk = window.sessionStorage.getItem(`${GHOST_PREFIX}${matchId}`);
  if (!pk) return null;
  try { assertPrivateKey(pk); }
  catch { window.sessionStorage.removeItem(`${GHOST_PREFIX}${matchId}`); return null; }
  return buildGhost(pk, () => window.sessionStorage.removeItem(`${GHOST_PREFIX}${matchId}`));
}

function buildGhost(pk: `0x${string}`, onDestroy: () => void): GhostWallet {
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({
    account,
    chain: EC_CHAIN,
    transport: ecHttpTransport(),
  });
  const pc = createPublicClient({ chain: EC_CHAIN, transport: ecHttpTransport() });
  const waitMined = async (hash: Hash) => {
    for (let i = 0; i < 40; i++) {
      try {
        const r = await pc.getTransactionReceipt({ hash });
        if (r) {
          if ((r as { status?: string }).status && (r as { status: string }).status !== "success") {
            throw new Error(`[ghost] tx reverted (status=${(r as { status: string }).status})`);
          }
          return r;
        }
      } catch (e) {
        if ((e as Error)?.message?.includes("reverted")) throw e;
        /* not mined yet */
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error("[ghost] tx did not confirm in time");
  };

  return {
    address: account.address,
    async signStakeRound({ matchId, playerAddress, round, amount, entryPrice }) {
      const hash = await wallet.writeContract({
        abi: DREAMDUEL_ROUND_ESCROW_ABI,
        address: ROUND_ESCROW_ADDRESS,
        functionName: "stakeRound",
        args: [matchKey(matchId, playerAddress), BigInt(round), amount, entryPrice],
        account: account,
        chain: EC_CHAIN,
        gas: 3_000_000n,
      });
      await waitMined(hash);
      return hash;
    },
    async signApproveEscrow(spender, amountRaw) {
      const hash = await wallet.writeContract({
        abi: TUSDC_ABI,
        address: TUSDC_ADDRESS,
        functionName: "approve",
        args: [spender, amountRaw],
        account: account,
        chain: EC_CHAIN,
        // Somnia tUSDC approve costs ~1.09M gas; the old 1M cap reverted
        // out-of-gas, which left the arena permanently "NOT STAKED" after the
        // player had already paid the deposit relay.
        gas: 1_500_000n,
      });
      await waitMined(hash);
      return hash;
    },
    async signWithdraw(matchId, playerAddress) {
      const hash = await wallet.writeContract({
        abi: DREAMDUEL_ROUND_ESCROW_ABI,
        address: ROUND_ESCROW_ADDRESS,
        functionName: "withdraw",
        args: [matchKey(matchId, playerAddress)],
        account: account,
        chain: EC_CHAIN,
        gas: 1_500_000n,
      });
      await waitMined(hash);
      return hash;
    },
    async signTransfer(to, amountRaw) {
      const hash = await wallet.writeContract({
        abi: TUSDC_ABI,
        address: TUSDC_ADDRESS,
        functionName: "transfer",
        args: [to, amountRaw],
        account: account,
        chain: EC_CHAIN,
        gas: 1_500_000n,
      });
      await waitMined(hash);
      return hash;
    },
    async ghostBalance() {
      return (await pc.readContract({
        abi: TUSDC_ABI,
        address: TUSDC_ADDRESS,
        functionName: "balanceOf",
        args: [account.address],
      })) as bigint;
    },
    destroy: onDestroy,
  };
}
