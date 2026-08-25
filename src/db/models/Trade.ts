import { randomUUID } from "node:crypto";
import { Schema, model } from "mongoose";

export const TRADE_STATUS = ["PENDING", "EXECUTED", "FAILED"] as const;
export type TradeStatus = (typeof TRADE_STATUS)[number];

export interface PledgedAsset {
  symbol: string;
  amount: number; // human-readable units
  usdValue: number;
}

/**
 * trades -- one participant's queued position inside a batch.
 *
 * `amount` is the aggregated base-token quantity (for executor compatibility).
 * `assets` stores the individual token breakdown for multi-asset pledges.
 */
export interface TradeDoc {
  _id: string; // uuid
  batchId: string; // batches._id
  userAddress: string; // users._id
  amount: number;
  assets: PledgedAsset[];
  dustSweep: boolean;
  status: TradeStatus;
  txHash?: string;
  executedAt?: Date;
  errorMessage?: string;
  createdAt: Date;
}

const PledgedAssetSchema = new Schema<PledgedAsset>(
  { symbol: { type: String, required: true }, amount: { type: Number, required: true }, usdValue: { type: Number, required: true } },
  { _id: false, versionKey: false },
);

const TradeSchema = new Schema<TradeDoc>(
  {
    _id: { type: String, default: () => randomUUID() },
    batchId: { type: String, ref: "Batch", required: true },
    userAddress: { type: String, ref: "User", required: true },
    amount: { type: Number, required: true },
    assets: { type: [PledgedAssetSchema], default: [] },
    dustSweep: { type: Boolean, default: false },
    status: { type: String, enum: TRADE_STATUS, default: "PENDING" },
    txHash: { type: String },
    executedAt: { type: Date },
    errorMessage: { type: String },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

TradeSchema.index({ batchId: 1, userAddress: 1 }, { unique: true });
TradeSchema.index({ batchId: 1, status: 1 });

export const Trade = model<TradeDoc>("Trade", TradeSchema, "trades");
