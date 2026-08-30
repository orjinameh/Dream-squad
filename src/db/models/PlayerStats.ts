import { Schema, model } from "mongoose";

export interface PlayerStatsDoc {
  _id: string;
  address: string;
  // Aggregate stats (kept for backwards compat)
  totalWins: number;
  totalLosses: number;
  totalDraws: number;
  totalMatches: number;
  totalRounds: number;
  correctPredictions: number;
  totalPredictions: number;
  longestStreak: number;
  currentStreak: number;
  favoriteChar: string;
  lastPlayedAt: Date;
  lastBotResultKey?: string;
  // PvP stats
  pvpWins: number;
  pvpLosses: number;
  pvpDraws: number;
  pvpMatches: number;
  pvpRounds: number;
  pvpCorrectPredictions: number;
  // Bot stats
  botWins: number;
  botLosses: number;
  botDraws: number;
  botMatches: number;
  botRounds: number;
  botCorrectPredictions: number;
  // Streaks
  bestWinStreak: number;
  bestPredictionStreak: number;
  currentWinStreak: number;
  currentPredictionStreak: number;
  // Combat
  knockouts: number;
  timesKnockedOut: number;
  // Rank
  rankPoints: number;
  // In-game USDso balance & P&L
  balance: number;
  totalPnL: number;
  // Idempotency: processed match IDs (capped at 200 most recent)
  processedMatches: string[];
  // Idempotency: processed round P&L credits (key = matchId:roundNum)
  processedRounds: string[];
}

const PlayerStatsSchema = new Schema<PlayerStatsDoc>(
  {
    _id: { type: String, required: true },
    address: { type: String, required: true, unique: true },
    // Aggregate
    totalWins: { type: Number, default: 0 },
    totalLosses: { type: Number, default: 0 },
    totalDraws: { type: Number, default: 0 },
    totalMatches: { type: Number, default: 0 },
    totalRounds: { type: Number, default: 0 },
    correctPredictions: { type: Number, default: 0 },
    totalPredictions: { type: Number, default: 0 },
    longestStreak: { type: Number, default: 0 },
    currentStreak: { type: Number, default: 0 },
    favoriteChar: { type: String, default: "dreamer" },
    lastPlayedAt: { type: Date, default: () => new Date() },
    lastBotResultKey: { type: String },
    // PvP
    pvpWins: { type: Number, default: 0 },
    pvpLosses: { type: Number, default: 0 },
    pvpDraws: { type: Number, default: 0 },
    pvpMatches: { type: Number, default: 0 },
    pvpRounds: { type: Number, default: 0 },
    pvpCorrectPredictions: { type: Number, default: 0 },
    // Bot
    botWins: { type: Number, default: 0 },
    botLosses: { type: Number, default: 0 },
    botDraws: { type: Number, default: 0 },
    botMatches: { type: Number, default: 0 },
    botRounds: { type: Number, default: 0 },
    botCorrectPredictions: { type: Number, default: 0 },
    // Streaks
    bestWinStreak: { type: Number, default: 0 },
    bestPredictionStreak: { type: Number, default: 0 },
    currentWinStreak: { type: Number, default: 0 },
    currentPredictionStreak: { type: Number, default: 0 },
    // Combat
    knockouts: { type: Number, default: 0 },
    timesKnockedOut: { type: Number, default: 0 },
    // Rank
    rankPoints: { type: Number, default: 0 },
    // Balance & P&L
    balance: { type: Number, default: 100 },
    totalPnL: { type: Number, default: 0 },
    // Idempotency
    processedMatches: { type: [String], default: [] },
    processedRounds: { type: [String], default: [] },
  },
  { versionKey: false },
);

PlayerStatsSchema.index({ totalWins: -1 });
PlayerStatsSchema.index({ correctPredictions: -1 });
PlayerStatsSchema.index({ rankPoints: -1 });

export const PlayerStats = model<PlayerStatsDoc>("PlayerStats", PlayerStatsSchema, "player_stats");
