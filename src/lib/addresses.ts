import { getAddress, isAddress } from "viem";

/**
 * Validate and normalize a user-supplied address to EIP-55 checksum form.
 * Users collection keys are checksummed addresses (_id = wallet address).
 *
 * Accepts any casing on input (MetaMask sends checksummed, WalletConnect may
 * not); throws on malformed input so zod can surface a clean 400.
 */
export function normalizeAddress(input: string): `0x${string}` {
  if (!isAddress(input)) {
    throw new Error(`invalid address: ${input}`);
  }
  return getAddress(input);
}

/** 0x1234...abcd -- safe to expose publicly (invite pages, lobbies). */
export function maskAddress(checksummed: string): string {
  return `${checksummed.slice(0, 6)}...${checksummed.slice(-4)}`;
}
