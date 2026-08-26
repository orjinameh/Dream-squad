import mongoose, { Schema, type Document, type Types } from "mongoose";

export type QueueStatus = "searching" | "matched";

export interface MatchQueueDoc {
  _id: string;
  address: string;
  rounds: 3 | 5 | 7 | 11;
  charId: string;
  status: QueueStatus;
  matchId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const MatchQueueSchema = new Schema(
  {
    _id: { type: String, required: true },
    address: { type: String, required: true, lowercase: true },
    rounds: { type: Number, required: true, enum: [3, 5, 7, 11] },
    charId: { type: String, required: true, default: "dreamer" },
    status: { type: String, required: true, default: "searching", enum: ["searching", "matched"] },
    matchId: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "match_queue", timestamps: true }
);

MatchQueueSchema.index({ status: 1, rounds: 1, createdAt: 1 });
MatchQueueSchema.index({ address: 1, status: 1 }, { unique: true, partialFilterExpression: { status: "searching" } });

export const MatchQueue =
  mongoose.models.MatchQueue || mongoose.model("MatchQueue", MatchQueueSchema, "match_queue");
