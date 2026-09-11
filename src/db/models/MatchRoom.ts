import mongoose, { Schema } from "mongoose";
import { randomBytes } from "node:crypto";

export type RoomStatus = "waiting" | "matched" | "cancelled";

export interface MatchRoomDoc {
  _id: string;
  /** Unique 6-char invite code ( unambiguous alphabet, no 0/O/1/I). */
  code: string;
  /** Host wallet (lowercase). */
  hostAddress: string;
  /** Guest wallet once claimed (lowercase). */
  guestAddress?: string;
  rounds: 3 | 5 | 7 | 11;
  hostCharId: string;
  status: RoomStatus;
  matchId?: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MatchRoomSchema = new Schema(
  {
    _id: { type: String, required: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, minlength: 9, maxlength: 9 },
    hostAddress: { type: String, required: true, lowercase: true, trim: true },
    guestAddress: { type: String, lowercase: true, trim: true },
    rounds: { type: Number, required: true, enum: [3, 5, 7, 11] },
    hostCharId: { type: String, required: true, default: "dreamer", maxlength: 32 },
    status: { type: String, required: true, default: "waiting", enum: ["waiting", "matched", "cancelled"] },
    matchId: { type: String, index: true },
    expiresAt: { type: Date, required: true },
    createdAt: { type: Date },
    updatedAt: { type: Date },
  },
  { collection: "match_rooms", timestamps: true },
);

MatchRoomSchema.index({ hostAddress: 1, status: 1 });
MatchRoomSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const MatchRoom: mongoose.Model<MatchRoomDoc> =
  mongoose.models.MatchRoom || mongoose.model<MatchRoomDoc>("MatchRoom", MatchRoomSchema, "match_rooms");

/** Room lifetime: codes die 10 minutes after creation (TTL backs it). */
export const ROOM_TTL_MS = 10 * 60_000;

/** Unambiguous code alphabet (no 0/O/1/I). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateRoomCode(): string {
  const bytes =
    typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
      ? (() => {
          const b = new Uint8Array(4);
          crypto.getRandomValues(b);
          return b;
        })()
      : randomBytes(4);
  return `DUEL-${Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("")}`;
}

export function normalizeRoomCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.trim().toUpperCase();
  if (!/^DUEL-[A-Z2-9]{4}$/.test(code)) return null;
  return code;
}
