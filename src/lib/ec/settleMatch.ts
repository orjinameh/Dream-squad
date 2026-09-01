/**
 * MATCH ESCROW IS REMOVED (v2 architecture).
 *
 * Under the exact model, combat MATCHES never move money — matches are purely
 * stats + ranks (bragging) made of 70s = 7 x 10s rounds. The FINANCIAL layer is
 * the player's persistent EC POSITION (~15-min window stake), settled once from
 * the real on-chain EC result.
 *
 * These functions are kept as explicit no-ops so old callers (predict route,
 * worker) compile and clearly signal that per-match on-chain escrow no longer
 * exists. Money settlement now lives in @/lib/ec/position (reconcilePositions).
 */

export type MatchLike = {
  _id: string;
  opponentType?: string;
  winner?: string | null;
  playerAddress?: string;
  player2Address?: string;
};

export async function settlePvpMatchEscrow(_match: MatchLike): Promise<"skipped"> {
  return "skipped"; // no per-match escrow; money lives on the EC position
}

export async function openBotMatchEscrow(_matchId: string, _player: string): Promise<"skipped"> {
  return "skipped"; // no per-match escrow; the player stakes an EC position instead
}

export async function settleBotMatchEscrow(_match: MatchLike): Promise<"skipped"> {
  return "skipped"; // no per-match escrow; the EC position settles the stake
}
