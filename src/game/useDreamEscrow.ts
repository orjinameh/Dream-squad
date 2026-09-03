"use client";

import { useCallback, useState } from "react";
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { parseUnits, formatUnits, createPublicClient, http, type Hash } from "viem";
import { EC_CHAIN, EC_RPC_URL, ESCROW_ADDRESS, ROUND_ESCROW_ADDRESS, EC_ADDRESSES, EC_COLLATERAL_DECIMALS } from "@/lib/ec/config";
import { DREAMDUEL_ESCROW_ABI, LEGACY_POSITION_ABI, DREAMDUEL_ROUND_ESCROW_ABI } from "@/lib/ec/escrowAbi";
import { matchKey } from "@/lib/ec/matchKey";

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
 * Client (browser) interface to the deployed DreamDuel escrow for an EC POSITION
 * (a single tUSDC stake for a 15-minute window). The player's own wallet
 * approves tUSDC and calls `stake(windowId, amount, entryPrice)` — money only
 * moves when their wallet signs. On win they call `withdraw(windowId)` to
 * collect the DEX payout (stake / entryPrice). Everything shown is read on-chain
 * via `position(windowId)`, never simulated. Keyed by windowId, NOT matchId —
 * combat matches are stats/rank only and ride the position.
 */
export function useDreamEscrow(windowId?: string | null, escrowAddress: `0x${string}` = ESCROW_ADDRESS) {
  const { address } = useAccount();
  const key = (windowId ?? undefined) as Hash | undefined;
  const escrow = escrowAddress ?? ESCROW_ADDRESS;

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
    args: address && key ? [address, escrow] : undefined,
    chainId: EC_CHAIN.id,
  });

  const pos = useReadContract({
    abi: DREAMDUEL_ESCROW_ABI,
    address: escrow,
    functionName: "position",
    args: key ? [key] : undefined,
    chainId: EC_CHAIN.id,
  });

  // Legacy (pre-v3) escrows return a 6-field struct that throws the current ABI
  // decoder. Probe with the legacy shape and normalize when the primary failed.
  const legacyPos = useReadContract({
    abi: LEGACY_POSITION_ABI,
    address: escrow,
    functionName: "position",
    args: key ? [key] : undefined,
    chainId: EC_CHAIN.id,
  });

  const raw = (pos.isError && legacyPos.data
    ? {
        owner: (legacyPos.data as any)[0] as `0x${string}`,
        balance: (legacyPos.data as any)[1] as bigint,
        entryPrice: 0n,
        windowOpen: (legacyPos.data as any)[2] as bigint,
        windowClose: (legacyPos.data as any)[3] as bigint,
        won: (legacyPos.data as any)[4] as bigint,
        open: (legacyPos.data as any)[5] as boolean,
        settled: (legacyPos.data as any)[6] as boolean,
      }
    : pos.data) as
    | {
        owner: `0x${string}`;
        balance: bigint;
        entryPrice: bigint;
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

  // Writes go through wagmi's useWriteContract, which drives the connected
  // connector's own client (WalletConnect-aware) — raw window.ethereum is never
  // set on a mobile WC session. Explicit gas is required (Somnia rejects
  // eth_estimateGas), and each write is raced against a 90s timeout so a hung
  // prompt surfaces an error instead of an endless STAKING... spinner.
  const [lastHash, setLastHash] = useState<`0x${string}` | null>(null);
  const receipt = useWaitForTransactionReceipt({ hash: lastHash ?? undefined, chainId: EC_CHAIN.id });
  const { writeContractAsync } = useWriteContract();

  const writeWithTimeout = useCallback(
    async (params: Parameters<typeof writeContractAsync>[0]): Promise<`0x${string}`> => {
      if (!writeContractAsync) throw new Error("Wallet not connected");
      return Promise.race([
        writeContractAsync({ ...params, gas: EC_TX_GAS } as any),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Wallet prompt timed out — check your wallet's popup/permission settings")), 90_000),
        ),
      ]) as Promise<`0x${string}`>;
    },
    [writeContractAsync],
  );

  // Approve the escrow to spend the stake, then open/restake the position.
  // `windowId` is the position the player just opened (returned by POST
  // /api/position) — the hook's own key is only set AFTER onOpenPosition runs,
  // so callers must pass the explicit windowId here. `entryPrice` is the player's
  // side entry price scaled 1e6 (server-computed from the live DEX YES price);
  // `windowClose` is the venue expiry (unix sec) that unlocks settlement.
  const approveAndStake = useCallback(
    async (windowId: Hash | string | null | undefined, amountRaw: bigint, entryPrice?: bigint, windowClose?: number) => {
      const wid = (windowId ?? key) as Hash | undefined;
      if (!wid || !address) throw new Error("Wallet not connected");
      const currentAllowance = allowance.data as bigint | undefined;
      if ((currentAllowance ?? 0n) < amountRaw) {
        const approveHash = await writeWithTimeout({
          abi: TUSDC_ABI,
          address: TUSDC_ADDRESS,
          functionName: "approve",
          args: [escrow, amountRaw],
          chainId: EC_CHAIN.id,
        });
        setLastHash(approveHash as `0x${string}`);
        await waitForReceipt(approveHash as `0x${string}`);
      }
      const stakeHash = await writeWithTimeout({
        abi: DREAMDUEL_ESCROW_ABI,
        address: escrow,
        functionName: "stake",
        args: [wid, amountRaw, entryPrice ? (entryPrice as bigint) : 500_000n, windowClose ? BigInt(windowClose) : 0n],
        chainId: EC_CHAIN.id,
      });
      setLastHash(stakeHash as `0x${string}`);
      await waitForReceipt(stakeHash as `0x${string}`);
      return stakeHash as `0x${string}`;
    },
    [key, address, allowance.data, escrow, writeWithTimeout],
  );

  // Collect a WON position (DEX payout = stake / entryPrice).
  const withdraw = useCallback(async () => {
    if (!key) throw new Error("No position");
    const hash = await writeWithTimeout({
      abi: DREAMDUEL_ESCROW_ABI,
      address: escrow,
      functionName: "withdraw",
      args: [key],
      chainId: EC_CHAIN.id,
    });
    setLastHash(hash as `0x${string}`);
    await waitForReceipt(hash as `0x${string}`);
    return hash as `0x${string}`;
  }, [key, escrow, writeWithTimeout]);

  /// ── Per-round escrow (DreamDuelRoundEscrow) ────────────────────────────────
  /// Each round is its OWN stake, keyed by (matchId, round); the round auto-
  /// settles at its close. `stakeRound` approves tUSDC and deposits round
  /// `round`'s amount; `roundWithdraw` collects the match's total won balance.
  const roundEscrow = ROUND_ESCROW_ADDRESS ?? escrow;

  const stakeRound = useCallback(
    async (matchId: Hash | string | null | undefined, round: number, amountRaw: bigint, entryPrice?: bigint) => {
      const mid = matchId == null ? undefined : matchKey(String(matchId), address);
      if (!mid || !address) throw new Error("Wallet not connected");
      const curAllowance = allowance.data as bigint | undefined;
      if ((curAllowance ?? 0n) < amountRaw) {
        const approveHash = await writeWithTimeout({
          abi: TUSDC_ABI,
          address: TUSDC_ADDRESS,
          functionName: "approve",
          args: [roundEscrow, amountRaw],
          chainId: EC_CHAIN.id,
        });
        setLastHash(approveHash as `0x${string}`);
        await waitForReceipt(approveHash as `0x${string}`);
      }
      const hash = await writeWithTimeout({
        abi: DREAMDUEL_ROUND_ESCROW_ABI,
        address: roundEscrow,
        functionName: "stakeRound",
        args: [mid, BigInt(round), amountRaw, entryPrice ? (entryPrice as bigint) : 500_000n],
        chainId: EC_CHAIN.id,
      });
      setLastHash(hash as `0x${string}`);
      await waitForReceipt(hash as `0x${string}`);
      return hash as `0x${string}`;
    },
    [address, allowance.data, roundEscrow, writeWithTimeout],
  );

  const roundWithdraw = useCallback(
    async (matchId: Hash | string | null | undefined) => {
      const mid = matchId == null ? undefined : matchKey(String(matchId), address);
      if (!mid || !address) throw new Error("No position");
      const hash = await writeWithTimeout({
        abi: DREAMDUEL_ROUND_ESCROW_ABI,
        address: roundEscrow,
        functionName: "withdraw",
        args: [mid],
        chainId: EC_CHAIN.id,
      });
      setLastHash(hash as `0x${string}`);
      await waitForReceipt(hash as `0x${string}`);
      return hash as `0x${string}`;
    },
    [address, roundEscrow, writeWithTimeout],
  );

  const getFaucet = useCallback(
    async (amountRaw: bigint) => {
      if (!address) throw new Error("Wallet not connected");
      const hash = await writeWithTimeout({
        abi: TUSDC_ABI,
        address: TUSDC_ADDRESS,
        functionName: "faucet",
        args: [amountRaw],
        chainId: EC_CHAIN.id,
      });
      setLastHash(hash as `0x${string}`);
      await waitForReceipt(hash as `0x${string}`);
      return hash as `0x${string}`;
    },
    [address, writeWithTimeout],
  );

  return {
    windowId: key,
    escrowAddress: escrow,
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
    entryPrice: raw?.entryPrice, // scaled 1e6 (UP = YES price, DOWN = NO price)
    stakeAmountFormatted: raw?.balance != null && raw.balance > 0n ? formatUnits(raw.balance, EC_COLLATERAL_DECIMALS) : null,
    approveAndStake,
    withdraw,
    stakeRound,
    roundWithdraw,
    roundEscrowAddress: roundEscrow,
    getFaucet,
    loading: usdc.isLoading || allowance.isLoading || pos.isLoading,
    refetch: () => {
      usdc.refetch();
      allowance.refetch();
      pos.refetch();
      legacyPos.refetch();
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

/**
 * Read the per-round on-chain escrow for a combat match. The server settles each
 * round via `settleRound(matchId, round, won)`; this exposes the resulting
 * on-chain truth (total `withdrawable`, per-round won/lost) so the UI can show
 * what the server actually committed on-chain — never a local guess.
 */
export function useRoundEscrow(matchId?: string | null) {
  const { address } = useAccount();
  const key = matchId && address ? matchKey(matchId, address) : undefined;
  const escrow: `0x${string}` = ROUND_ESCROW_ADDRESS ?? ESCROW_ADDRESS;

  const withdrawable = useReadContract({
    abi: DREAMDUEL_ROUND_ESCROW_ABI,
    address: escrow,
    functionName: "withdrawable",
    args: key ? [key] : undefined,
    chainId: EC_CHAIN.id,
  });

  const matchOwner = useReadContract({
    abi: DREAMDUEL_ROUND_ESCROW_ABI,
    address: escrow,
    functionName: "matchOwner",
    args: key ? [key] : undefined,
    chainId: EC_CHAIN.id,
  });

  const isMine = Boolean(matchOwner.data && address && (matchOwner.data as `0x${string}`).toLowerCase() === address.toLowerCase());

  return {
    matchId: key,
    escrowAddress: escrow,
    withdrawable: (withdrawable.data as bigint | undefined) ?? 0n,
    withdrawableFormatted: withdrawable.data != null ? formatUnits(withdrawable.data as bigint, EC_COLLATERAL_DECIMALS) : null,
    isMine,
    refetch: () => {
      withdrawable.refetch();
      matchOwner.refetch();
    },
  };
}
