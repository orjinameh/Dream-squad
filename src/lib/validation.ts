import { z } from "zod";
import { isAddress } from "viem";
import { MARKETS } from "./markets";

/** Lobby durations offered by the Creator UI: 60s / 3m / 5m. */
export const DURATION_SECONDS = [60, 180, 300] as const;

const addressSchema = z
  .string()
  .refine((v) => isAddress(v), "invalid EVM address");

export const createSyndicateSchema = z.object({
  creatorAddress: addressSchema,
  market: z.enum(Object.keys(MARKETS) as [string, ...string[]]),
  direction: z.enum(["BUY", "SELL"]),
  durationSeconds: z.union(DURATION_SECONDS.map((s) => z.literal(s)) as unknown as [z.ZodLiteral<number>, z.ZodLiteral<number>, z.ZodLiteral<number>]),
  amount: z.number().positive(),
});

export const joinSyndicateSchema = z.object({
  userAddress: addressSchema,
  batchId: z.string().min(1),
  amount: z.number().positive(),
});

export type CreateSyndicateInput = z.infer<typeof createSyndicateSchema>;
export type JoinSyndicateInput = z.infer<typeof joinSyndicateSchema>;
