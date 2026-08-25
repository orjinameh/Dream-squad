import { randomUUID } from "node:crypto";
import { Schema, model } from "mongoose";

export const MATCH_STATUS = ["ACTIVE", "COMPLETED", "ABANDONED"] as const;
export type MatchStatus = (typeof MATCH_STATUS)[number];

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
  playerScore: number;
  rivalScore: number;
  winner: "player" | "rival" | "draw";
  rounds: RoundRecord[];
  status: MatchStatus;
  createdAt: Date;
  completedAt?: Date;
}

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
    playerScore: { type: Number, default: 0 },
    rivalScore: { type: Number, default: 0 },
    winner: { type: String, enum: ["player", "rival", "draw"], default: "player" },
    rounds: { type: [RoundSchema], default: [] },
    status: { type: String, enum: MATCH_STATUS, default: "ACTIVE" },
    createdAt: { type: Date, default: () => new Date() },
    completedAt: { type: Date },
  },
  { versionKey: false },
);

MatchSchema.index({ playerAddress: 1, createdAt: -1 });

export const Match = model<MatchDoc>("Match", MatchSchema, "matches");
