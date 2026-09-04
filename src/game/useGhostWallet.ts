"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useWriteContract } from "wagmi";
import { parseUnits, createPublicClient } from "viem";
import { EC_COLLATERAL_DECIMALS, ROUND_ESCROW_ADDRESS, ESCROW_ADMIN, EC_CHAIN, ecHttpTransport, EC_ADDRESSES } from "@/lib/ec/config";
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
  const pc = createPublicClient({ chain: EC_CHAIN, transport: ecHttpTransport() });
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
  // Track an in-flight, unused allowance grant (approve written but the deposit
  // never relayed) so it can be auto-revoked after a short window instead of
  // sitting open on the player's wallet indefinitely.
  const [grantPending, setGrantPending] = useState(false);
  const grantAtRef = useRef(0);
  const revokingRef = useRef(false);

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

    // Hard timebox so `funding` can never hang the UI on a perpetual spinner:
    // if the approve popup or the relay never confirms, give up and reset the
    // flag so the manual FUND MATCH button becomes clickable again.
    let settled = false;
    const guard = new Promise<never>((_, reject) => {
      setTimeout(() => {
        if (!settled) {
          settled = true;
          setFunding(false);
          reject(new Error("funding timed out — check your wallet popup and try again"));
        }
      }, 60_000);
    });

    try {
      const body = (async () => {
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
        // The grant is now live but not yet consumed. Start the auto-revoke
        // window so an approve that's never used (fight not started within a few
        // minutes) is cleared from the wallet instead of sitting open.
        grantAtRef.current = Date.now();
        setGrantPending(true);

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
        setGrantPending(false);
        return data;
      })();

      return await Promise.race([body, guard]);
    } catch (e) {
      setError((e as Error)?.message ?? "failed to fund ghost");
      throw e;
    } finally {
      settled = true;
      setFunding(false);
    }
  }, [matchId, address, ghost, totalStakeRaw, writeContractAsync]);

  // AUTO-REVOKE of an unused allowance grant. A standard ERC-20 approve can't
  // self-expire, so if the deposit was never relayed within the window we write
  // approve(0) to clear the open 70 tUSDC grant off the player's wallet instead
  // of letting it sit indefinitely. Only fires once (per in-flight grant), only
  // when the grant actually went unused, and only if the allowance still covers
  // it (so we never revoke an authorization that was already consumed/reduced).
  useEffect(() => {
    if (!grantPending || funded || !address || revokingRef.current) return;
    const REVOKE_AFTER_MS = 5 * 60_000;
    const startedAt = grantAtRef.current || Date.now();
    const delay = Math.max(0, REVOKE_AFTER_MS - (Date.now() - startedAt));
    const t = setTimeout(async () => {
      if (revokingRef.current) return;
      if (funded) return;
      try {
        revokingRef.current = true;
        const now = await allowanceOf(address, ESCROW_ADMIN);
        if (now < totalStakeRaw) {
          // Grant already consumed or reduced elsewhere — nothing to clear.
          setGrantPending(false);
          return;
        }
        await writeContractAsync({
          abi: TUSDC_ABI,
          address: TUSDC_ADDRESS,
          functionName: "approve",
          args: [ESCROW_ADMIN, 0n],
          chainId: EC_CHAIN.id,
          gas: 30_000_000n,
        } as any);
        setGrantPending(false);
      } catch (e) {
        console.warn("[ghost] auto-revoke of unused allowance failed", (e as Error)?.message);
        // Keep grantPending so the next mount/fund can still attempt cleanup.
      } finally {
        revokingRef.current = false;
      }
    }, delay);
    return () => clearTimeout(t);
  }, [grantPending, funded, address, totalStakeRaw, writeContractAsync]);

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
   *  Runs on MATCH_RESULT even if funding partially failed.
   *
   *  SAFETY: the ghost's private key in sessionStorage is the ONLY way to move
   *  whatever tUSDC it still holds. If a withdraw/forward reverts and any balance
   *  remains, we MUST NOT destroy the key — doing so would permanently lock that
   *  money. The key is only dropped once the on-chain balance is confirmed 0, and
   *  any leftover that couldn't be reclaimed keeps the key alive (sessionStorage
   *  persists for the tab) so a later retry can still recover the funds. */
  const settleAndForward = useCallback(async () => {
    if (!matchId || !ghost || !address) {
      setFunded(false);
      return;
    }
    let leftover: bigint | null = null;
    try {
      await ghost.signWithdraw(matchId, address);
    } catch (e) {
      console.warn("[ghost] withdraw failed, forwarding balance anyway", (e as Error)?.message);
    }
    try {
      const before = await ghost.ghostBalance();
      if (before > 0n) {
        await ghost.signTransfer(address, before);
        // Confirm the money actually left before we consider it safe to clear.
        leftover = await ghost.ghostBalance();
        if (leftover > 0n) {
          console.warn(`[ghost] ${leftover} tUSDC still in ghost after forward — key retained for safe retry`);
        }
      } else {
        leftover = 0n;
      }
    } catch (e) {
      console.warn("[ghost] forward failed, retaining key to avoid stranding funds", (e as Error)?.message);
      // Re-read so we know whether the key must survive.
      try { leftover = await ghost.ghostBalance(); } catch { leftover = null; }
    }

    if (leftover === 0n) {
      // Balance fully reclaimed — safe to clear the ghost so the next fight
      // starts from clean state.
      ghost.destroy();
      setGhost(null);
    }
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
  const pc = createPublicClient({ chain: EC_CHAIN, transport: ecHttpTransport() });
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
