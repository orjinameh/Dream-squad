import { Schema, model } from "mongoose";

/**
 * users -- keyed by the user's wallet address (EIP-55 checksummed).
 *
 * operatorAuthorized: the user signed setOperatorApprovalForPool granting our
 *   backend key placeOrderFor/cancelOrderFor on a pool (spot delegation).
 * vaultInitialized: the user opted into manual-vault mode and deposited
 *   working capital (Phase 1 spike flow). Without it the sweep cannot fund
 *   orders from their balance.
 */
export interface UserDoc {
  _id: string; // checksummed wallet address
  operatorAuthorized: boolean;
  vaultInitialized: boolean;
  updatedAt: Date;
}

const UserSchema = new Schema<UserDoc>(
  {
    _id: { type: String, required: true },
    operatorAuthorized: { type: Boolean, default: false },
    vaultInitialized: { type: Boolean, default: false },
    updatedAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

export const User = model<UserDoc>("User", UserSchema, "users");
