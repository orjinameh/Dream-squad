import { settleOnchain, drawOnchain, settleSoloOnchain } from "./escrow";
import { ESCROW_HOUSE } from "./config";

export type MatchLike = {
  _id: string;
  opponentType?: string;
  winner?: string | null;
  playerAddress?: string;
  player2Address?: string;
};

async function setEscrowStatus(id: string, status: "SETTLED" | "DRAWN" | "FAILED") {
  try {
    const { Match } = await import("@/db/models/Match");
    await Match.updateOne({ _id: id }, { $set: { escrowStatus: status } });
  } catch {
    /* non-fatal; worker re-sweeps by escrowStatus/status */
  }
}

/**
 * Settle a completed PvP match on the DreamDuel escrow.
 *
 * Only real PvP (opponentType === "player") matches have an on-chain pot. The
 * escrow pays the full pot to the winner, or refunds both on a draw. The
 * contract guards require both players to have actually staked — if they
 * haven't yet (or the escrow wasn't opened), the write reverts and is logged
 * here so the settlement worker can reconcile when the stake lands.
 *
 * This is never mocked: money only moves when the real on-chain escrow accepts
 * the settle/draw call.
 */
export async function settlePvpMatchEscrow(match: MatchLike): Promise<"settled" | "drawn" | "skipped"> {
  if (match.opponentType !== "player") return "skipped";
  if (!match.playerAddress || !match.player2Address) return "skipped";

  const winner = match.winner;
  try {
    if (winner === "draw") {
      await drawOnchain(match._id);
      await setEscrowStatus(match._id, "DRAWN");
      return "drawn";
    }
    const winnerAddr =
      winner === "player" ? match.playerAddress as `0x${string}`
      : winner === "rival" ? match.player2Address as `0x${string}`
      : null;
    if (!winnerAddr) return "skipped";
    await settleOnchain(match._id, winnerAddr);
    await setEscrowStatus(match._id, "SETTLED");
    return "settled";
  } catch (err) {
    console.error(`[settle] escrow settle failed for match=${match._id} (worker will reconcile)`, err);
    await setEscrowStatus(match._id, "FAILED").catch(() => {});
    return "skipped";
  }
}

/**
 * Open a SOLO escrow for a bot match: register `(player, HOUSE)`. The bot is
 * the `house` participant and NEVER stakes — only the human player's real
 * tUSDC moves. Requires the redeployed escrow (with `settleSolo`).
 *
 * Idempotent-safe: opening an already-open match reverts, which is swallowed.
 */
export async function openBotMatchEscrow(matchId: string, player: string): Promise<"opened" | "skipped"> {
  try {
    const { openMatchOnchain } = await import("./escrow");
    await openMatchOnchain(matchId, player as `0x${string}`, ESCROW_HOUSE);
    return "opened";
  } catch (err) {
    // Already open (MatchNotOpen) or contract mismatch — reconcile via worker.
    console.error(`[settle] open bot escrow failed for match=${matchId} (worker will reconcile)`, err);
    return "skipped";
  }
}

/**
 * Settle a completed BOT match on the escrow (solo path).
 *
 * The player is the only real staker (the bot / house never stakes). On a
 * player win or draw the escrow refunds the player's stake; on a loss the
 * stake is sent to the `house` treasury. If the player never staked (opted out
 * / practice), nothing moves and this is a no-op skip.
 */
export async function settleBotMatchEscrow(match: MatchLike): Promise<"settled" | "skipped"> {
  if (match.opponentType !== "bot") return "skipped";
  if (!match.playerAddress) return "skipped";

  try {
    const won = match.winner === "player" || match.winner === "draw";
    await settleSoloOnchain(match._id, won);
    await setEscrowStatus(match._id, won ? "DRAWN" : "SETTLED");
    return "settled";
  } catch (err) {
    console.error(`[settle] bot escrow settle failed for match=${match._id} (worker will reconcile)`, err);
    await setEscrowStatus(match._id, "FAILED").catch(() => {});
    return "skipped";
  }
}
