"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { createPublicClient, http, parseUnits } from "viem";
import { SOMNIA_CHAIN, SPOT_POOL_ABI, OPERATOR_ADDRESS, OPERATOR_REGISTRY_ABI, SELECTORS } from "@/lib/config";
import { MARKETS } from "@/lib/markets";

const RPC_URL = process.env.NEXT_PUBLIC_SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network";

export interface DreamDEXStatus {
  delegationReady: boolean;
  vaultReady: boolean;
  loading: boolean;
  error: string | null;
}

export function useDreamDEX(marketSymbol: string = "SOMI:USDso") {
  const { address } = useAccount();
  const [status, setStatus] = useState<DreamDEXStatus>({
    delegationReady: false,
    vaultReady: false,
    loading: true,
    error: null,
  });

  const { writeContractAsync } = useWriteContract();

  // Check delegation and vault status
  const checkStatus = useCallback(async () => {
    if (!address) {
      setStatus({ delegationReady: false, vaultReady: false, loading: false, error: null });
      return;
    }

    const market = MARKETS[marketSymbol];
    if (!market) return;

    setStatus((s) => ({ ...s, loading: true, error: null }));

    try {
      const pc = createPublicClient({ chain: SOMNIA_CHAIN, transport: http(RPC_URL) });

      // Check delegation
      let delegationReady = false;
      try {
        delegationReady = await pc.readContract({
          address: market.pool,
          abi: SPOT_POOL_ABI,
          functionName: "isOperatorAuthorized",
          args: [address, OPERATOR_ADDRESS, SELECTORS.placeOrderFor],
        });
      } catch {
        delegationReady = false;
      }

      // Check vault
      let vaultReady = false;
      try {
        vaultReady = await pc.readContract({
          address: market.pool,
          abi: SPOT_POOL_ABI,
          functionName: "getManualVaultMode",
          args: [address],
        });
      } catch {
        vaultReady = false;
      }

      setStatus({ delegationReady, vaultReady, loading: false, error: null });
    } catch (err) {
      setStatus((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to check DreamDEX status",
      }));
    }
  }, [address, marketSymbol]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // Grant operator delegation
  const grantDelegation = useCallback(async () => {
    if (!address) throw new Error("Wallet not connected");
    const market = MARKETS[marketSymbol];
    if (!market) throw new Error("Unknown market");

    try {
      const hash = await writeContractAsync({
        address: "0x15C7e8CE38F021c5b45d098AaD788f63090bF20A",
        abi: OPERATOR_REGISTRY_ABI,
        functionName: "setOperatorApprovalForPool",
        args: [
          market.pool,
          OPERATOR_ADDRESS,
          [SELECTORS.placeOrderFor, SELECTORS.cancelOrderFor],
          true,
        ],
      });

      // Wait for confirmation
      const pc = createPublicClient({ chain: SOMNIA_CHAIN, transport: http(RPC_URL) });
      await pc.waitForTransactionReceipt({ hash });

      setStatus((s) => ({ ...s, delegationReady: true }));
      return hash;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Delegation failed";
      setStatus((s) => ({ ...s, error: msg }));
      throw err;
    }
  }, [address, marketSymbol, writeContractAsync]);

  // Initialize vault
  const initVault = useCallback(async () => {
    if (!address) throw new Error("Wallet not connected");
    const market = MARKETS[marketSymbol];
    if (!market) throw new Error("Unknown market");

    try {
      // Enable manual vault mode
      const hash = await writeContractAsync({
        address: market.pool,
        abi: SPOT_POOL_ABI,
        functionName: "setManualVaultMode",
        args: [true],
      });

      const pc = createPublicClient({ chain: SOMNIA_CHAIN, transport: http(RPC_URL) });
      await pc.waitForTransactionReceipt({ hash });

      setStatus((s) => ({ ...s, vaultReady: true }));
      return hash;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Vault init failed";
      setStatus((s) => ({ ...s, error: msg }));
      throw err;
    }
  }, [address, marketSymbol, writeContractAsync]);

  // Ensure both delegation and vault are ready
  const ensureReady = useCallback(async () => {
    if (!address) throw new Error("Wallet not connected");

    await checkStatus();
    const current = status;

    if (!current.delegationReady) {
      await grantDelegation();
    }

    if (!current.vaultReady) {
      await initVault();
    }

    setStatus({ delegationReady: true, vaultReady: true, loading: false, error: null });
  }, [address, status, checkStatus, grantDelegation, initVault]);

  return {
    status,
    checkStatus,
    grantDelegation,
    initVault,
    ensureReady,
    isReady: status.delegationReady && status.vaultReady,
  };
}
