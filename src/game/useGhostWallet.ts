"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useWriteContract } from "wagmi";
import { parseUnits, createPublicClient, http } from "viem";
import { EC_COLLATERAL_DECIMALS, ROUND_ESCROW_ADDRESS, ESCROW_ADMIN, EC_CHAIN, EC_RPC_URL, EC_ADDRESSES } from "@/lib/ec/config";
import { getOrCreateGhost, type GhostWallet } from "./ghostWallet";

const TUSDC_ADDRESS: `0x${string}` = (EC_ADDRESSES.testUsdc ?? EC_ADDRESSES.collateral)!;

const TUSDC_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
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
] as const;

async function allowanceOf(owner: `0x${string}`, spender: `0x${string}`): Promise<bigint> {
  const pc = createPublicClient({ chain: EC_CHAIN, transport: http(EC_RPC_URL) });
  return (await pc.readContract({
    abi: TUSDC_ABI,
    address: TUSDC_ADDRESS,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;
}

/**
 * Ephemeral (ghost) wallet for a fight: ONE approval popup at lobby, then every
 * per-round on-chain call is signed by an in-memory private key — zero popups
 * mid-fight. The server relays the single deposit into the ghost; the ghost
 * approves the round escrow and signs each round's `stakeRound`; the server
 * settles; at the end the ghost withdraws and forwards winnings to the primary.
 */
export function useGhostWallet(matchId: string | null, totalRounds: number, amountPerRound: number) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [ghost, setGhost] = useState<GhostWallet | null>(null);
  const [funded, setFunded] = useState(false);
  const [funding, setFunding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create/recover the ghost key for this match in browser memory.
  useEffect(() => {
    if (!matchId) { setGhost(null); return; }
    try {
      setGhost(getOrCreateGhost(matchId));
    } catch (e) {
      setError((e as Error)?.message ?? "failed to init ghost wallet");
    }
  }, [matchId]);

  const totalStakeRaw = amountPerRound > 0 && totalRounds > 0
    ? parseUnits(String(amountPerRound * totalRounds), EC_COLLATERAL_DECIMALS)
    : 0n;

  /**
   * Lobby funding (THE one popup): ask the player's PRIMARY wallet for a single
   * `approve(ESCROW_ADMIN)` covering totalStake, then the server relays
   * player->ghost. After this, the ghost signs every round (no popups).
   */
  const fundGhost = useCallback(async () => {
    if (!matchId || !address || !ghost) throw new Error("not ready");
    if (totalStakeRaw <= 0n) throw new Error("invalid stake");
    setFunding(true); setError(null);
    try {
      // ONE popup: approve the operator to move totalStake for this match.
      const existing = await allowanceOf(address, ESCROW_ADMIN);
      if (existing < totalStakeRaw) {
        const approveHash = await writeContractAsync({
          abi: TUSDC_ABI,
          address: TUSDC_ADDRESS,
          functionName: "approve",
          args: [ESCROW_ADMIN, totalStakeRaw],
          chainId: EC_CHAIN.id,
          gas: 30_000_000n,
        } as any);
        await waitForReceipt(approveHash as `0x${string}`);
      }

      const res = await fetch("/api/matches/ghost/fund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matchId,
          playerAddress: address,
          ghostAddress: ghost.address,
          totalStakeRaw: totalStakeRaw.toString(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "fund ghost failed");

      // Ghost approves the round escrow so it can move its own funds per round.
      await ghost.signApproveEscrow(ROUND_ESCROW_ADDRESS, parseUnits("1000000", EC_COLLATERAL_DECIMALS));
      setFunded(true);
      return data;
    } catch (e) {
      setError((e as Error)?.message ?? "failed to fund ghost");
      throw e;
    } finally {
      setFunding(false);
    }
  }, [matchId, address, ghost, totalStakeRaw, writeContractAsync]);

  /**
   * Stake ONE round on-chain using the ghost key (no popup). Call this when a
   * round opens, keyed by round, before the server settles it.
   */
  const stakeRound = useCallback(
    async (round: number, entryPrice: bigint) => {
      if (!matchId || !ghost || !address) return;
      const amountRaw = parseUnits(String(amountPerRound), EC_COLLATERAL_DECIMALS);
      await ghost.signStakeRound({ matchId, playerAddress: address, round, amount: amountRaw, entryPrice });
    },
    [matchId, ghost, address, amountPerRound],
  );

  /** End of match: withdraw any winnings, forward leftovers to the primary
   *  wallet, and fully clear the ghost so the next match starts from clean state.
   *  Runs on MATCH_RESULT even if funding partially failed, so funds are never
   *  stranded and `funded` always reverts to false. */
  const settleAndForward = useCallback(async () => {
    if (!matchId || !ghost || !address) return;
    try {
      await ghost.signWithdraw(matchId, address);
    } catch (e) {
      console.warn("[ghost] withdraw failed, forwarding balance anyway", (e as Error)?.message);
    }
    try {
      const bal = await ghost.ghostBalance();
      if (bal > 0n) {
        await ghost.signTransfer(address, bal);
      }
    } catch (e) {
      console.warn("[ghost] forward failed", (e as Error)?.message);
    }
    ghost.destroy();
    setGhost(null);
    setFunded(false);
  }, [matchId, ghost, address]);

  return {
    address: ghost?.address ?? null,
    funded,
    funding,
    error,
    totalStakeRaw,
    fundGhost,
    stakeRound,
    settleAndForward,
  };
}

async function waitForReceipt(hash: `0x${string}`) {
  const pc = createPublicClient({ chain: EC_CHAIN, transport: http(EC_RPC_URL) });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await pc.getTransactionReceipt({ hash });
      if (r) return r;
    } catch {
      /* not mined yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("approve did not confirm in time");
}
