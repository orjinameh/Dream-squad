"use client";

import { createWalletClient, createPublicClient, http, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EC_CHAIN, EC_RPC_URL, ROUND_ESCROW_ADDRESS, EC_ADDRESSES } from "@/lib/ec/config";
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
  signStakeRound(args: { matchId: string; round: number; amount: bigint; entryPrice: bigint }): Promise<Hash>;
  signApproveEscrow(spender: `0x${string}`, amountRaw: bigint): Promise<Hash>;
  signWithdraw(matchId: string): Promise<Hash>;
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

/** Random PEP-5218-compliant 32-byte private key (CSPRNG). */
function randomPrivateKey(): `0x${string}` {
  const bytes = new Uint8Array(32);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[0] &= 0x7f; // keep < secp256k1 order domain
  bytes[31] |= 0x01;
  return `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

export function getOrCreateGhost(matchId: string): GhostWallet {
  if (typeof window === "undefined") throw new Error("[ghost] no window (SSR)");
  const storage = window.sessionStorage;
  const key = `${GHOST_PREFIX}${matchId}`;
  let pk = storage.getItem(key);
  if (!pk) {
    pk = randomPrivateKey();
    storage.setItem(key, pk);
  }
  return buildGhost(pk as `0x${string}`, () => storage.removeItem(key));
}

/** Rebuild a ghost from an already-persisted key (SSR/navigation safe). */
export function loadGhost(matchId: string): GhostWallet | null {
  if (typeof window === "undefined") return null;
  const pk = window.sessionStorage.getItem(`${GHOST_PREFIX}${matchId}`);
  if (!pk) return null;
  return buildGhost(pk as `0x${string}`, () => window.sessionStorage.removeItem(`${GHOST_PREFIX}${matchId}`));
}

function buildGhost(pk: `0x${string}`, onDestroy: () => void): GhostWallet {
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({
    account,
    chain: EC_CHAIN,
    transport: http(EC_RPC_URL),
  });
  const pc = createPublicClient({ chain: EC_CHAIN, transport: http(EC_RPC_URL) });
  const waitMined = async (hash: Hash) => {
    for (let i = 0; i < 40; i++) {
      try {
        const r = await pc.getTransactionReceipt({ hash });
        if (r) return r;
      } catch {
        /* not mined yet */
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error("[ghost] tx did not confirm in time");
  };

  return {
    address: account.address,
    async signStakeRound({ matchId, round, amount, entryPrice }) {
      const hash = await wallet.writeContract({
        abi: DREAMDUEL_ROUND_ESCROW_ABI,
        address: ROUND_ESCROW_ADDRESS,
        functionName: "stakeRound",
        args: [matchKey(matchId), BigInt(round), amount, entryPrice],
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
        gas: 1_000_000n,
      });
      await waitMined(hash);
      return hash;
    },
    async signWithdraw(matchId) {
      const hash = await wallet.writeContract({
        abi: DREAMDUEL_ROUND_ESCROW_ABI,
        address: ROUND_ESCROW_ADDRESS,
        functionName: "withdraw",
        args: [matchKey(matchId)],
        account: account,
        chain: EC_CHAIN,
        gas: 1_000_000n,
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
        gas: 1_000_000n,
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
