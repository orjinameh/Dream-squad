import { createPublicClient, http, formatUnits } from "viem";
import { OPERATOR_MIN_GAS_BUFFER } from "./markets";

// Somnia Shannon testnet. Phase 3's executor signs with the backend operator
// key; users only sign the one-time grant on their own wallets.
const CHAIN_ID = 50312;
const RPC_URL = process.env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network";

const publicClient = createPublicClient({
  transport: http(RPC_URL),
});

export const somniaChain = { id: CHAIN_ID, rpcUrl: RPC_URL };

/**
 * Account warmup check (Phase 1 learning): raw Somnia nodes reject broadcasts
 * from never-funded accounts ("account does not exist") and from zero-balance
 * senders ("insufficient balance"). Any wallet that will BROADCAST during a
 * sweep -- today the backend operator; in self-execution fallbacks the user --
 * must hold at least OPERATOR_MIN_GAS_BUFFER native before the timer expires.
 *
 * Returns whether the address is warm and its current native balance.
 */
export async function checkAccountWarmup(address: string): Promise<{
  warm: boolean;
  balance: number;
  minRequired: number;
}> {
  const balanceWei = await publicClient.getBalance({ address: address as `0x${string}` });
  const balance = Number(formatUnits(balanceWei, 18));
  return {
    warm: balance >= OPERATOR_MIN_GAS_BUFFER,
    balance,
    minRequired: OPERATOR_MIN_GAS_BUFFER,
  };
}
