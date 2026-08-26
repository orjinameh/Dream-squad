import { Schema, model } from "mongoose";

export interface PlayerStatsDoc {
  _id: string;
  address: string;
  totalWins: number;
  totalLosses: number;
  totalDraws: number;
  totalMatches: number;
  totalRounds: number;
  correctPredictions: number;
  longestStreak: number;
  currentStreak: number;
  favoriteChar: string;
  lastPlayedAt: Date;
  lastBotResultKey?: string;
}

const PlayerStatsSchema = new Schema<PlayerStatsDoc>(
  {
    _id: { type: String, required: true },
    address: { type: String, required: true, unique: true },
    totalWins: { type: Number, default: 0 },
    totalLosses: { type: Number, default: 0 },
    totalDraws: { type: Number, default: 0 },
    totalMatches: { type: Number, default: 0 },
    totalRounds: { type: Number, default: 0 },
    correctPredictions: { type: Number, default: 0 },
    longestStreak: { type: Number, default: 0 },
    currentStreak: { type: Number, default: 0 },
    favoriteChar: { type: String, default: "dreamer" },
    lastPlayedAt: { type: Date, default: () => new Date() },
    lastBotResultKey: { type: String },
  },
  { versionKey: false },
);

PlayerStatsSchema.index({ totalWins: -1 });
PlayerStatsSchema.index({ correctPredictions: -1 });

export const PlayerStats = model<PlayerStatsDoc>("PlayerStats", PlayerStatsSchema, "player_stats");
