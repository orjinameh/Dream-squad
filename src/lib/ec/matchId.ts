import { keccak256, toHex, type Hash } from "viem";

/**
 * Derive the on-chain bytes32 match key from an arbitrary app match id.
 *
 * Both the server escrow client and the browser wagmi hooks must agree on this
 * mapping — the escrow contract indexes matches by this bytes32.
 */
export function escrowMatchId(id: string): Hash {
  return keccak256(toHex(id));
}
