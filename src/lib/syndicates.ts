import { randomBytes } from "node:crypto";

/** Invite slug, e.g. "squad-somi-k3f9". Short, typable, collision-tolerant at
 *  hackathon scale; the unique index on batches._id is the real guarantee. */
export function generateBatchId(market: string): string {
  const base = market.split(":")[0].toLowerCase();
  const suffix = randomBytes(2).toString("hex");
  return `squad-${base}-${suffix}`;
}

export function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
