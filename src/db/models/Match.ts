import { randomUUID } from "node:crypto";
import { Schema, model } from "mongoose";

export const MATCH_STATUS = ["ACTIVE", "COMPLETED", "ABANDONED"] as const;
export type MatchStatus = (typeof MATCH_STATUS)[number];

export const ROUND_PHASE = ["WAITING", "ACTIVE", "LOCKED", "REVEALED"] as const;
export type RoundPhase = (typeof ROUND_PHASE)[number];

export interface RoundRecord {
  roundNum: number;
  playerPrediction: "UP" | "DOWN" | null;
  rivalPrediction: "UP" | "DOWN" | null;
  actual: "UP" | "DOWN";
  playerCorrect: boolean;
  rivalCorrect: boolean;
}

export interface MatchDoc {
  _id: string;
  playerAddress: string;
  playerChar: string;
  rivalName: string;
  rivalChar: string;
  mode: string;
  totalRounds: number;
  currentRound: number;
  roundPhase: RoundPhase;
  roundStartTime: Date;
  roundDeadline: Date;
  playerScore: number;
  rivalScore: number;
  winner: "player" | "rival" | "draw";
  rounds: RoundRecord[];
  playerPrediction: "UP" | "DOWN" | null;
  rivalPrediction: "UP" | "DOWN" | null;
  status: MatchStatus;
  createdAt: Date;
  completedAt?: Date;
  // PvP fields
  opponentType: "bot" | "player";
  player2Address?: string;
  player2Char?: string;
  player1Ready: boolean;
  player2Ready: boolean;
}

const ROUND_DURATION_MS = 10_000;
const LOCK_MS = 1_200;
const REVEAL_MS = 1_500;
const IMPACT_MS = 1_400;

const RoundSchema = new Schema<RoundRecord>(
  {
    roundNum: { type: Number, required: true },
    playerPrediction: { type: String, enum: ["UP", "DOWN", null], default: null },
    rivalPrediction: { type: String, enum: ["UP", "DOWN", null], default: null },
    actual: { type: String, enum: ["UP", "DOWN"], required: true },
    playerCorrect: { type: Boolean, required: true },
    rivalCorrect: { type: Boolean, required: true },
  },
  { _id: false, versionKey: false },
);

const MatchSchema = new Schema<MatchDoc>(
  {
    _id: { type: String, default: () => randomUUID() },
    playerAddress: { type: String, required: true, index: true },
    playerChar: { type: String, required: true },
    rivalName: { type: String, required: true },
    rivalChar: { type: String, required: true },
    mode: { type: String, required: true },
    totalRounds: { type: Number, required: true },
    currentRound: { type: Number, default: 1 },
    roundPhase: { type: String, enum: ROUND_PHASE, default: "WAITING" },
    roundStartTime: { type: Date, default: () => new Date() },
    roundDeadline: { type: Date, required: true },
    playerScore: { type: Number, default: 0 },
    rivalScore: { type: Number, default: 0 },
    winner: { type: String, enum: ["player", "rival", "draw"], default: "player" },
    rounds: { type: [RoundSchema], default: [] },
    playerPrediction: { type: String, enum: ["UP", "DOWN", null], default: null },
    rivalPrediction: { type: String, enum: ["UP", "DOWN", null], default: null },
    status: { type: String, enum: MATCH_STATUS, default: "ACTIVE" },
    createdAt: { type: Date, default: () => new Date() },
    completedAt: { type: Date },
    // PvP fields
    opponentType: { type: String, enum: ["bot", "player"], default: "bot" },
    player2Address: { type: String },
    player2Char: { type: String },
    player1Ready: { type: Boolean, default: true },
    player2Ready: { type: Boolean, default: false },
  },
  { versionKey: false },
);

MatchSchema.index({ playerAddress: 1, status: 1 });
MatchSchema.index({ playerAddress: 1, createdAt: -1 });
MatchSchema.index({ player2Address: 1, status: 1 });

export const ROUND_TIMINGS = { ROUND_DURATION_MS, LOCK_MS, REVEAL_MS, IMPACT_MS } as const;

export const Match = model<MatchDoc>("Match", MatchSchema, "matches");
