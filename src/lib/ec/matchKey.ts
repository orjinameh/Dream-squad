import { keccak256, toHex, type Hash } from "viem";

/**
 * Derive the on-chain `bytes32` key for a combat match from its Mongo `_id`.
 *
 * Match `_id`s are UUID strings (Mongoose String _id), which are NOT valid
 * bytes32. The per-round escrow keys all state by `bytes32 matchId`, so every
 * caller (the server's settle relay AND the client's ghost staking/wallet read)
 * MUST derive the SAME 32-byte value from the same `_id` or the on-chain lookups
 * won't line up. A deterministic keccak256 of the string id gives that.
 *
 * Usage: pass the raw Mongo match `_id` (string) here; get a stable `0x…`
 * 32-byte hash for any contract call on the round escrow.
 */
export function matchKey(matchId: string): Hash {
  return keccak256(toHex(matchId));
}
