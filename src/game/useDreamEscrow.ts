"use client";

import { useCallback, useState } from "react";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { parseUnits, formatUnits, createPublicClient, http } from "viem";
import { EC_CHAIN, EC_RPC_URL, ESCROW_ADDRESS, EC_ADDRESSES, EC_COLLATERAL_DECIMALS } from "@/lib/ec/config";
import { escrowMatchId } from "@/lib/ec/matchId";
import { DREAMDUEL_ESCROW_ABI } from "@/lib/ec/escrowAbi";

export const TUSDC_ADDRESS: `0x${string}` =
  (EC_ADDRESSES.testUsdc ?? EC_ADDRESSES.collateral)!;

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
  {
    type: "function",
    name: "faucet",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

export type EscrowMatch = {
  playerA: `0x${string}`;
  playerB: `0x${string}`;
  stake: bigint;
  stakedA: boolean;
  stakedB: boolean;
  settled: boolean;
  drawn: boolean;
  createdAt: bigint;
};

/**
 * Client (browser) interface to the deployed DreamDuel escrow for a PvP match.
 * This is the REAL on-chain path: the player's own wallet approves tUSDC and
 * calls `stake` — money only moves when their wallet signs. The pot shown is
 * read from-chain, never simulated.
 */
export function useDreamEscrow(matchId?: string) {
  const { address } = useAccount();
  const matchKey = matchId ? escrowMatchId(matchId) : undefined;

  const usdc = useReadContract({
    abi: TUSDC_ABI,
    address: TUSDC_ADDRESS,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: EC_CHAIN.id,
  });

  const allowance = useReadContract({
    abi: TUSDC_ABI,
    address: TUSDC_ADDRESS,
    functionName: "allowance",
    args: address && matchKey ? [address, ESCROW_ADDRESS] : undefined,
    chainId: EC_CHAIN.id,
  });

  const match = useReadContract({
    abi: DREAMDUEL_ESCROW_ABI,
    address: ESCROW_ADDRESS,
    functionName: "matches",
    args: matchKey ? [matchKey] : undefined,
    chainId: EC_CHAIN.id,
  });

  const rawMatch = match.data as EscrowMatch | undefined;
  const isOpen = Boolean(rawMatch && (rawMatch.playerA !== "0x0000000000000000000000000000000000000000" || rawMatch.playerB !== "0x0000000000000000000000000000000000000000"));
  const isParticipant = Boolean(address && rawMatch && (rawMatch.playerA === address || rawMatch.playerB === address));
  const hasStaked = Boolean(rawMatch && address && ((rawMatch.playerA === address && rawMatch.stakedA) || (rawMatch.playerB === address && rawMatch.stakedB)));
  const bothStaked = Boolean(rawMatch?.stakedA && rawMatch.stakedB);

  const { writeContractAsync } = useWriteContract();
  const [lastHash, setLastHash] = useState<`0x${string}` | null>(null);
  const receipt = useWaitForTransactionReceipt({ hash: lastHash ?? undefined, chainId: EC_CHAIN.id });

  // Set allowance high enough to cover the stake, then stake.
  const approveAndStake = useCallback(
    async (amountRaw: bigint) => {
      if (!matchKey || !address) throw new Error("Wallet not connected");
      const currentAllowance = allowance.data as bigint | undefined;
      if ((currentAllowance ?? 0n) < amountRaw) {
        const approveHash = (await writeContractAsync({
          abi: TUSDC_ABI,
          address: TUSDC_ADDRESS,
          functionName: "approve",
          args: [ESCROW_ADDRESS, amountRaw],
          chainId: EC_CHAIN.id,
        }))!;
        setLastHash(approveHash);
        await waitForReceipt(approveHash);
      }
      const stakeHash = (await writeContractAsync({
        abi: DREAMDUEL_ESCROW_ABI,
        address: ESCROW_ADDRESS,
        functionName: "stake",
        args: [matchKey, amountRaw],
        chainId: EC_CHAIN.id,
      }))!;
      setLastHash(stakeHash);
      await waitForReceipt(stakeHash);
      return stakeHash;
    },
    [matchKey, address, allowance.data, writeContractAsync],
  );

  const refund = useCallback(async () => {
    if (!matchKey) throw new Error("No match");
    const hash = (await writeContractAsync({
      abi: DREAMDUEL_ESCROW_ABI,
      address: ESCROW_ADDRESS,
      functionName: "refund",
      args: [matchKey],
      chainId: EC_CHAIN.id,
    }))!;
    setLastHash(hash);
    await waitForReceipt(hash);
    return hash;
  }, [matchKey, writeContractAsync]);

  const getFaucet = useCallback(
    async (amountRaw: bigint) => {
      if (!address) throw new Error("Wallet not connected");
      const hash = await writeContractAsync({
        abi: TUSDC_ABI,
        address: TUSDC_ADDRESS,
        functionName: "faucet",
        args: [amountRaw],
        chainId: EC_CHAIN.id,
      });
      setLastHash(hash);
      await waitForReceipt(hash);
      return hash;
    },
    [address, writeContractAsync],
  );

  return {
    matchId: matchKey,
    address,
    usdcBalance: usdc.data as bigint | undefined,
    usdcBalanceFormatted: usdc.data != null ? formatUnits(usdc.data as bigint, EC_COLLATERAL_DECIMALS) : null,
    allowance: allowance.data as bigint | undefined,
    onchain: rawMatch,
    isOpen,
    isParticipant,
    hasStaked,
    bothStaked,
    stakeAmountFormatted: rawMatch?.stake != null && rawMatch.stake > 0n ? formatUnits(rawMatch.stake, EC_COLLATERAL_DECIMALS) : null,
    settled: rawMatch?.settled,
    drawn: rawMatch?.drawn,
    approveAndStake,
    refund,
    getFaucet,
    loading: usdc.isLoading || allowance.isLoading || match.isLoading,
    refetch: () => {
      usdc.refetch();
      allowance.refetch();
      match.refetch();
    },
  };
}

async function waitForReceipt(hash: `0x${string}`) {
  const pc = createPublicClient({ chain: EC_CHAIN, transport: http(EC_RPC_URL) });
  for (let i = 0; i < 30; i++) {
    try {
      const r = await pc.getTransactionReceipt({ hash });
      if (r) return r;
    } catch {
      /* not mined yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("transaction did not confirm in time");
}
