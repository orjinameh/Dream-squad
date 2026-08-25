import { Schema, model } from "mongoose";

export const BATCH_STATUS = ["OPEN", "PROCESSING", "EXECUTED", "FAILED"] as const;
export type BatchStatus = (typeof BATCH_STATUS)[number];

/**
 * batches -- one synchronized co-op trade ("Syndicate"), joined via invite slug.
 *
 * The executor worker (Phase 3) claims documents stuck in OPEN whose closesAt
 * has passed using an atomic findOneAndUpdate({_id, status: "OPEN"},
 * { status: "PROCESSING" }) so two workers can never double-fire a batch.
 */
export interface BatchDoc {
  _id: string; // invite slug, e.g. squad-btc-492
  creatorAddress: string; // users._id
  market: string; // e.g. SOMI:USDso
  direction: "BUY" | "SELL";
  status: BatchStatus;
  opensAt: Date;
  closesAt: Date;
  totalPool: number;
  createdAt: Date;
}

const BatchSchema = new Schema<BatchDoc>(
  {
    _id: { type: String, required: true },
    creatorAddress: { type: String, ref: "User", required: true, index: true },
    market: { type: String, required: true },
    direction: { type: String, enum: ["BUY", "SELL"], required: true },
    status: { type: String, enum: BATCH_STATUS, default: "OPEN", index: true },
    opensAt: { type: Date, default: () => new Date() },
    closesAt: { type: Date, required: true },
    totalPool: { type: Number, default: 0 },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

export const Batch = model<BatchDoc>("Batch", BatchSchema, "batches");
