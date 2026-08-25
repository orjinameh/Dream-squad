import { randomUUID } from "node:crypto";
import { Schema, model } from "mongoose";

export const TRADE_STATUS = ["PENDING", "EXECUTED", "FAILED"] as const;
export type TradeStatus = (typeof TRADE_STATUS)[number];

/**
 * trades -- one participant's queued position inside a batch.
 *
 * The executor writes back txHash + executedAt on success (EXECUTED) or
 * errorMessage on revert (FAILED). One intent per user per batch is enforced
 * at the index level so a double-tap on Join cannot inflate the pool.
 */
export interface TradeDoc {
  _id: string; // uuid
  batchId: string; // batches._id
  userAddress: string; // users._id
  amount: number;
  status: TradeStatus;
  txHash?: string;
  executedAt?: Date;
  errorMessage?: string;
  createdAt: Date;
}

const TradeSchema = new Schema<TradeDoc>(
  {
    _id: { type: String, default: () => randomUUID() },
    batchId: { type: String, ref: "Batch", required: true },
    userAddress: { type: String, ref: "User", required: true },
    amount: { type: Number, required: true },
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
