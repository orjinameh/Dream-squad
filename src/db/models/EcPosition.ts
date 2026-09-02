import { randomUUID } from "node:crypto";
import { Schema, model, Types } from "mongoose";
import type { EcArenaMarket } from "@/lib/ec/executor";

export const POSITION_STATUS = ["ACTIVE", "SETTLED", "FAILED"] as const;
export type PositionStatus = (typeof POSITION_STATUS)[number];

/**
 * An EC POSITION — the player's persistent financial stake on a DreamDEX
 * Event-Contract window ("UP / $10").
 *
 * MODEL:
 *   - Lives for the DreamDEX ~15-minute window (financial layer).
 *   - The stake IS the position; its balance does NOT change during the window.
 *   - While active it is referenced by multiple 70-second combat MATCHES (stats/
 *     rank only). Matches never touch this position's money.
 *   - Settles ONCE when the EC window resolves: win → DEX payout (stake /
 *     entryPrice, i.e. the fixed $1.00 per token), loss → stake forfeited (admin
 *     collects). Switching UP↔DOWN requires a new position.
 *   - The on-chain escrow slot (windowId) holds the real tUSDC.
 */
export interface EcPositionDoc {
  _id: string;
  address: string;
  direction: "UP" | "DOWN";
  market: string; // asset e.g. "BTC" | "ETH"
  amount: number; // stake $ (human units)
  // Pinned EC arena floor + window-open anchors (stable across the window)
  arena?: EcArenaMarket;
  arenaOpen?: number;
  // The player's side entry price scaled 1e6 (UP = YES price, DOWN = NO price) —
  // the v3 escrow's fixed $1.00-per-token payout uses this on a win.
  entryPrice?: string;
  // The escrow deployment that holds this stake (positions predating a redeploy
  // have no field; the resolver falls back through ESCROW_LEGACY_BY_AGE).
  escrowAddress?: string;
  // Lifecycle
  status: PositionStatus;
  windowId?: string; // on-chain escrow slot id (bytes32 hex)
  stakeTxHash?: string; // the player's `stake()` transaction on-chain (0x…)
  windowOpenAt?: Date;
  windowCloseAt?: Date; // when the EC window is expected to resolve
  settledWon?: boolean; // resolved binary result (null while unsettled)
  settledAt?: Date;
  // idempotency + settlement sync
  settledOnchain: boolean;
  // how many combat matches rode this position (stats, not money)
  matchCount: number;
  createdAt: Date;
}

export const EcPositionSchema = new Schema<EcPositionDoc>(
  {
    _id: { type: String, default: () => randomUUID() },
    address: { type: String, required: true, index: true },
    direction: { type: String, enum: ["UP", "DOWN"], required: true },
    market: { type: String, required: true },
    amount: { type: Number, required: true },
    arena: { type: Schema.Types.Mixed },
    arenaOpen: { type: Number },
    entryPrice: { type: String },
    escrowAddress: { type: String },
    status: { type: String, enum: POSITION_STATUS, default: "ACTIVE" },
    windowId: { type: String },
    stakeTxHash: { type: String },
    windowOpenAt: { type: Date },
    windowCloseAt: { type: Date },
    settledWon: { type: Boolean },
    settledAt: { type: Date },
    settledOnchain: { type: Boolean, default: false },
    matchCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

EcPositionSchema.index({ address: 1, status: 1 });
EcPositionSchema.index({ status: 1, windowCloseAt: 1 });

export const EcPosition = model<EcPositionDoc>("EcPosition", EcPositionSchema, "ecpositions");
