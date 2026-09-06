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
    address: { type: String, required: true, lowercase: true, trim: true },
    rounds: { type: Number, required: true, enum: [3, 5, 7, 11] },
    charId: { type: String, required: true, default: "dreamer", maxlength: 32 },
    status: { type: String, required: true, default: "searching", enum: ["searching", "matched"] },
    matchId: { type: String, index: true },
    createdAt: { type: Date },
    updatedAt: { type: Date },
  },
  { collection: "match_queue", timestamps: true }
);

MatchQueueSchema.index({ status: 1, rounds: 1, createdAt: 1 });
MatchQueueSchema.index({ address: 1, status: 1 }, { unique: true, partialFilterExpression: { status: "searching" } });
// TTL only on searching entries — a matched entry must survive until the client
// polls its matchId. Expiring matched rows strands the opponent.
MatchQueueSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 120, partialFilterExpression: { status: "searching" } });

export const MatchQueue =
  mongoose.models.MatchQueue || mongoose.model("MatchQueue", MatchQueueSchema, "match_queue");
