import { randomUUID } from "node:crypto";
import { Match, ROUND_TIMINGS } from "@/db/models/Match";
import type { EcPositionDoc } from "@/db/models/EcPosition";

const READY_TIMEOUT_MS = 30_000;

const RIVAL_NAMES = ["RAVEN", "CIPHER", "NOVA", "BLAZE", "PHANTOM", "STORM", "VIPER", "NEXUS", "ORBIT", "ZENITH", "PULSE", "DASH", "NIMBUS", "FROST", "APEX"];

export function modeForRounds(rounds: number): string {
  return rounds === 3 ? "quick" : rounds === 5 ? "clash" : rounds === 7 ? "battle" : "war";
}

export interface PvpPairInput {
  /** Joining player (checksummed): becomes playerAddress. */
  address: string;
  charId: string;
  /** Waiting player (lowercase ok): becomes player2Address. */
  opponentAddress: string;
  opponentCharId: string;
  rounds: 3 | 5 | 7 | 11;
  /** The JOINER's funded position (money + balances ride it). */
  position: Pick<EcPositionDoc, "_id" | "amount" | "direction"> & { windowId?: string };
  amountPerRound: number;
}

/**
 * Create a PvP match for a paired duo. Shared by the public queue and private
 * rooms so both paths produce identical matches. The joiner is player 1, the
 * waiter's perspective is mirrored by the state route.
 */
export async function createPvpMatch(input: PvpPairInput): Promise<{ matchId: string }> {
  const matchId = randomUUID();
  const nowDate = new Date();
  const deadline = new Date(nowDate.getTime() + READY_TIMEOUT_MS + ROUND_TIMINGS.ROUND_DURATION_MS);
  const p2Name = RIVAL_NAMES[Math.floor(Math.random() * RIVAL_NAMES.length)];

  await Match.create({
    _id: matchId,
    playerAddress: input.address,
    playerChar: input.charId || "dreamer",
    rivalName: p2Name,
    rivalChar: input.opponentCharId || "dreamer",
    mode: modeForRounds(input.rounds),
    totalRounds: input.rounds,
    currentRound: 1,
    roundPhase: "WAITING",
    roundStartTime: nowDate,
    roundDeadline: deadline,
    playerScore: 0,
    rivalScore: 0,
    winner: "player",
    rounds: [],
    playerPrediction: null,
    rivalPrediction: null,
    status: "ACTIVE",
    opponentType: "player",
    player2Address: input.opponentAddress,
    player2Char: input.opponentCharId || "dreamer",
    player1Ready: false,
    player2Ready: false,
    funded: true,
    // Ride the joiner's funded position size (never a silent default).
    playerAmountPerRound: input.amountPerRound,
    playerStartBalance: input.position.amount,
    rivalStartBalance: input.position.amount,
    playerBalance: input.position.amount,
    rivalBalance: input.position.amount,
    // Reference the joiner's active EC position (money lives there, not here).
    positionId: input.position._id,
    positionWindowId: input.position.windowId,
    positionDirection: input.position.direction,
    positionAmount: input.position.amount,
  });

  return { matchId };
}
