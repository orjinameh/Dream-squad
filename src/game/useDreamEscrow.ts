"use client";

import { useCallback, useState } from "react";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { parseUnits, formatUnits, createPublicClient, http, type Hash } from "viem";
import { EC_CHAIN, EC_RPC_URL, ESCROW_ADDRESS, EC_ADDRESSES, EC_COLLATERAL_DECIMALS } from "@/lib/ec/config";
import { DREAMDUEL_ESCROW_ABI } from "@/lib/ec/escrowAbi";

export const TUSDC_ADDRESS: `0x${string}` =
  (EC_ADDRESSES.testUsdc ?? EC_ADDRESSES.collateral)!;

// Somnia testnet rejects `eth_estimateGas`, so browser writes must carry an
// explicit gas cap or the tx is never constructed (no wallet popup appears).
// The escrow deploy required ~11.9M gas (30M cap); use 30M for player writes.
const EC_TX_GAS = 30_000_000n;

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

/**
 * Client (browser) interface to the deployed v2 DreamDuel escrow for an EC
 * POSITION (a single tUSDC stake for a 15-minute window). The player's own
 * wallet approves tUSDC and calls `stake(windowId, amount)` — money only moves
 * when their wallet signs. On win they call `withdraw(windowId)` to collect in
 * full. Everything shown is read on-chain via `position(windowId)`, never
 * simulated. Keyed by windowId, NOT matchId — combat matches are stats/rank
 * only and ride the plan.
 */
export function useDreamEscrow(windowId?: string | null) {
  const { address } = useAccount();
  const key = (windowId ?? undefined) as Hash | undefined;

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
    args: address && key ? [address, ESCROW_ADDRESS] : undefined,
    chainId: EC_CHAIN.id,
  });

  const pos = useReadContract({
    abi: DREAMDUEL_ESCROW_ABI,
    address: ESCROW_ADDRESS,
    functionName: "position",
    args: key ? [key] : undefined,
    chainId: EC_CHAIN.id,
  });

  const raw = pos.data as
    | {
        owner: `0x${string}`;
        balance: bigint;
        windowOpen: bigint;
        windowClose: bigint;
        won: bigint; // 0 pending / 1 won / 2 lost
        open: boolean;
        settled: boolean;
      }
    | undefined;

  const isMine = Boolean(raw && address && (raw.owner as `0x${string}`).toLowerCase() === address.toLowerCase());
  const isOpen = Boolean(raw?.open && !raw?.settled);
  const hasStaked = Boolean(raw && isMine && raw.balance > 0n);

  const { writeContractAsync } = useWriteContract();
  const [lastHash, setLastHash] = useState<`0x${string}` | null>(null);
  const receipt = useWaitForTransactionReceipt({ hash: lastHash ?? undefined, chainId: EC_CHAIN.id });

  // Approve the escrow to spend the stake, then open/restake the position.
  // `windowId` is the position the player just opened (returned by POST
  // /api/position) — the hook's own key is only set AFTER onOpenPosition runs,
  // so callers must pass the explicit windowId here.
  const approveAndStake = useCallback(
    async (windowId: Hash | string | null | undefined, amountRaw: bigint) => {
      const wid = (windowId ?? key) as Hash | undefined;
      if (!wid || !address) throw new Error("Wallet not connected");
      const currentAllowance = allowance.data as bigint | undefined;
      if ((currentAllowance ?? 0n) < amountRaw) {
        const approveHash = (await writeContractAsync({
          abi: TUSDC_ABI,
          address: TUSDC_ADDRESS,
          functionName: "approve",
          args: [ESCROW_ADDRESS, amountRaw],
          gas: EC_TX_GAS,
          chainId: EC_CHAIN.id,
        }))!;
        setLastHash(approveHash);
        await waitForReceipt(approveHash);
      }
      const stakeHash = (await writeContractAsync({
        abi: DREAMDUEL_ESCROW_ABI,
        address: ESCROW_ADDRESS,
        functionName: "stake",
        args: [wid, amountRaw],
        gas: EC_TX_GAS,
        chainId: EC_CHAIN.id,
      }))!;
      setLastHash(stakeHash);
      await waitForReceipt(stakeHash);
      return stakeHash;
    },
    [key, address, allowance.data, writeContractAsync],
  );

  // Collect a WON position (stake returned in full).
  const withdraw = useCallback(async () => {
    if (!key) throw new Error("No position");
    const hash = (await writeContractAsync({
      abi: DREAMDUEL_ESCROW_ABI,
      address: ESCROW_ADDRESS,
      functionName: "withdraw",
      args: [key],
      chainId: EC_CHAIN.id,
    }))!;
    setLastHash(hash);
    await waitForReceipt(hash);
    return hash;
  }, [key, writeContractAsync]);

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
    windowId: key,
    address,
    usdcBalance: usdc.data as bigint | undefined,
    usdcBalanceFormatted: usdc.data != null ? formatUnits(usdc.data as bigint, EC_COLLATERAL_DECIMALS) : null,
    allowance: allowance.data as bigint | undefined,
    onchain: raw,
    isMine,
    isOpen,
    hasStaked,
    won: raw?.won, // 0 pending / 1 won / 2 lost
    settled: raw?.settled,
    stakeAmountFormatted: raw?.balance != null && raw.balance > 0n ? formatUnits(raw.balance, EC_COLLATERAL_DECIMALS) : null,
    approveAndStake,
    withdraw,
    getFaucet,
    loading: usdc.isLoading || allowance.isLoading || pos.isLoading,
    refetch: () => {
      usdc.refetch();
      allowance.refetch();
      pos.refetch();
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
