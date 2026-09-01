import { keccak256, toHex, type Hash } from "viem";

/**
 * Derive the on-chain bytes32 window (position) key for an EC position.
 *
 * An EC position is the player's financial stake ("UP / $10") that lives for a
 * DreamDEX 15-minute lifecycle. Each position gets its own on-chain escrow slot
 * so it settles independently (win → stake returned in full, loss → forfeited).
 * The key MUST include the direction + a stable per-position nonce so that:
 *   - switching UP↔DOWN is a NEW position (new slot), and
 *   - re-staking the same direction after settling is not confused with the
 *     previous (already settled) slot.
 *
 * Both the server escrow client and the browser hooks must agree on this mapping.
 */
export function positionWindowId(opts: {
  address: `0x${string}`;
  direction: "UP" | "DOWN";
  market: string;
  nonce: string | number;
}): Hash {
  return keccak256(
    toHex(`${opts.address.toLowerCase()}:${opts.direction}:${opts.market}:${opts.nonce}`),
  );
}

/** Backwards-compatible name kept so any straggler import still resolves. */
export function escrowMatchId(id: string): Hash {
  return keccak256(toHex(id));
}
