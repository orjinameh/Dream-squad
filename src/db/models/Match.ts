import { randomUUID } from "node:crypto";
import { Schema, model } from "mongoose";
import type { MatchPriceModel } from "@/lib/prices";

export const MATCH_STATUS = ["ACTIVE", "COMPLETED", "ABANDONED"] as const;
export type MatchStatus = (typeof MATCH_STATUS)[number];

export const ROUND_PHASE = ["WAITING", "ACTIVE", "EXECUTING", "REVEALED", "TRANSITIONING"] as const;
export type RoundPhase = (typeof ROUND_PHASE)[number];

export type StatsProcessedStatus = "PENDING" | "PROCESSING" | "COMPLETE" | "FAILED";

export type EscrowStatus = "PENDING" | "SETTLED" | "DRAWN" | "FAILED";

export interface RoundRecord {
  roundNum: number;
  playerPrediction: "UP" | "DOWN" | null;
  rivalPrediction: "UP" | "DOWN" | null;
  actual: "UP" | "DOWN" | "FLAT";
  playerCorrect: boolean;
  rivalCorrect: boolean;
  // Coherent market price series this round's outcome derives from
  startPrice?: number;
  endPrice?: number;
  prices?: number[];
  asset?: string;
  // Trading P&L (per player), in STT
  playerPnL?: number;
  rivalPnL?: number;
  // Balances after settlement
  playerBalance?: number;
  rivalBalance?: number;
  // Server-authoritative combat
  roundWinner: "player" | "rival" | "draw";
  damage: number;
  playerDamage: number;
  rivalDamage: number;
  isCritical: boolean;
  knockout: boolean;
  // DreamDEX execution tracking
  playerExecution?: {
    status: "PENDING" | "EXECUTED" | "FAILED";
    txHash?: string;
    blockNumber?: number;
    blockHash?: string;
    gasUsed?: number;
    direction?: "BUY" | "SELL";
    amount?: number;
    error?: string;
  };
  rivalExecution?: {
    status: "PENDING" | "EXECUTED" | "FAILED";
    txHash?: string;
    blockNumber?: number;
    blockHash?: string;
    gasUsed?: number;
    direction?: "BUY" | "SELL";
    amount?: number;
    error?: string;
  };
  resolvedAt?: Date;
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
  // Prediction config
  predictionAsset: string;
  predictionQuestion: string;
  // Bot difficulty
  botDifficulty: "easy" | "normal" | "hard";
  // DreamDEX market integration
  marketId: string;
  executionConfig: {
    marketSymbol: string;
    poolAddress: string;
    amountPerRound: number;
  };
  // Server-authoritative combat state
  playerHP: number;
  rivalHP: number;
  playerStreak: number;
  rivalStreak: number;
  // Trading balance lifecycle (STT)
  playerStartBalance: number;
  rivalStartBalance: number;
  // Per-player independent trade amounts (STT)
  playerAmountPerRound: number;
  rivalAmountPerRound: number;
  playerFinalBalance?: number;
  rivalFinalBalance?: number;
  // Single continuous market the whole match trades against
  priceModel?: MatchPriceModel;
  // Stats idempotency (lifecycle)
  statsProcessed: StatsProcessedStatus;
  // On-chain escrow settlement state (PvP only)
  escrowStatus?: EscrowStatus;
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
    actual: { type: String, enum: ["UP", "DOWN", "FLAT"], required: true },
    playerCorrect: { type: Boolean, required: true },
    rivalCorrect: { type: Boolean, required: true },
    // Coherent market price series this round's outcome derives from
    startPrice: { type: Number },
    endPrice: { type: Number },
    prices: { type: [Number] },
    asset: { type: String },
    // Trading P&L (per player), in STT
    playerPnL: { type: Number },
    rivalPnL: { type: Number },
    playerBalance: { type: Number },
    rivalBalance: { type: Number },
    // Server-authoritative combat
    roundWinner: { type: String, enum: ["player", "rival", "draw"], required: true },
    damage: { type: Number, default: 0 },
    playerDamage: { type: Number, default: 0 },
    rivalDamage: { type: Number, default: 0 },
    isCritical: { type: Boolean, default: false },
    knockout: { type: Boolean, default: false },
    playerExecution: {
      status: { type: String, enum: ["PENDING", "EXECUTED", "FAILED"] },
      txHash: { type: String },
      blockNumber: { type: Number },
      blockHash: { type: String },
      gasUsed: { type: Number },
      direction: { type: String, enum: ["BUY", "SELL"] },
      amount: { type: Number },
      error: { type: String },
    },
    rivalExecution: {
      status: { type: String, enum: ["PENDING", "EXECUTED", "FAILED"] },
      txHash: { type: String },
      blockNumber: { type: Number },
      blockHash: { type: String },
      gasUsed: { type: Number },
      direction: { type: String, enum: ["BUY", "SELL"] },
      amount: { type: Number },
      error: { type: String },
    },
    resolvedAt: { type: Date },
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
    // Prediction config
    predictionAsset: { type: String, default: "BTC" },
    predictionQuestion: { type: String, default: "WILL BTC GO UP OR DOWN?" },
    // Bot difficulty
    botDifficulty: { type: String, enum: ["easy", "normal", "hard"], default: "normal" },
    // DreamDEX market integration
    marketId: { type: String, default: "SOMI:USDso" },
    executionConfig: {
      marketSymbol: { type: String, default: "SOMI:USDso" },
      poolAddress: { type: String, default: "0x259fD6559214dd5aD3752322426eA9F9fABEFff4" },
      amountPerRound: { type: Number, default: 1 },
    },
    // Server-authoritative combat state
    playerHP: { type: Number, default: 100 },
    rivalHP: { type: Number, default: 100 },
    playerStreak: { type: Number, default: 0 },
    rivalStreak: { type: Number, default: 0 },
    // Per-player independent trade amount (STT). Each player picks their own
    // stake; it drives real on-chain DreamDEX order size and this player's P&L
    // only — it is independent of what the opponent chose.
    playerAmountPerRound: { type: Number, default: 1 },
    rivalAmountPerRound: { type: Number, default: 1 },
    // Trading balance lifecycle (STT)
    playerStartBalance: { type: Number, default: 100 },
    rivalStartBalance: { type: Number, default: 100 },
    playerFinalBalance: { type: Number },
    rivalFinalBalance: { type: Number },
    priceModel: { type: Schema.Types.Mixed },
    statsProcessed: { type: String, enum: ["PENDING", "PROCESSING", "COMPLETE", "FAILED"], default: "PENDING" },
    escrowStatus: { type: String, enum: ["PENDING", "SETTLED", "DRAWN", "FAILED"], default: "PENDING" },
  },
  { versionKey: false },
);

MatchSchema.index({ playerAddress: 1, status: 1 });
MatchSchema.index({ playerAddress: 1, createdAt: -1 });
MatchSchema.index({ player2Address: 1, status: 1 });
MatchSchema.index({ status: 1 });

export const ROUND_TIMINGS = { ROUND_DURATION_MS, LOCK_MS, REVEAL_MS, IMPACT_MS } as const;

export const Match = model<MatchDoc>("Match", MatchSchema, "matches");
