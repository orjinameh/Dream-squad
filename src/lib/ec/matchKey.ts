import { keccak256, toHex, type Hash } from "viem";

/**
 * Derive the on-chain `bytes32` key for a combat match from its Mongo `_id` and
 * the (primary) player address.
 *
 * Match `_id`s are UUID strings (Mongoose String _id) — NOT valid bytes32 — and
 * the per-round escrow keys all state by `bytes32 matchId`. Every caller (the
 * server's settle relay AND the client's ghost staking/wallet read) MUST derive
 * the SAME 32-byte value or on-chain lookups won't line up.
 *
 * The key is PER PLAYER (matchId + playerAddress): the round escrow holds a
 * single lock per (key, round), so two PvP players staking the same round of the
 * SAME match would collide as `RoundAlreadyStaked`. Namespacing by player gives
 * each player an independent escrow slot. Player addresses are lowercased so
 * EIP-55 casing on one side can't mismatch a bare-lowercase hash on the other.
 *
 * Usage: pass the raw Mongo match `_id` (string) and the player's address; get a
 * stable `0x…` 32-byte hash for any contract call on the round escrow.
 */
export function matchKey(matchId: string, playerAddress?: string | null): Hash {
  const player = playerAddress ? playerAddress.toLowerCase() : "player";
  return keccak256(toHex(`${matchId}:${player}`));
}
