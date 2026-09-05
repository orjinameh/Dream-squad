import { NextRequest } from "next/server";
import { connectToDatabase } from "@/db/connect";
import { settleRoundStakes } from "@/lib/ec/settleRoundStakes";
import { reconcilePositions } from "@/lib/ec/position";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (
    req.headers.get("authorization") === `Bearer ${secret}` ||
    req.nextUrl.searchParams.get("secret") === secret
  );
}

/**
 * Cron-backed settlement sweep (Vercel cron → GET /api/cron/sweep) and the
 * local process worker (npm run worker) run the SAME idempotent jobs:
 *
 *   - settleRoundStakes(): per-round match stakes whose pinned arena RESOLVED
 *     are redeemed (won/refunded) and their net P&L stored.
 *   - reconcilePositions(): settle legacy one-shot EC positions from their
 *     real on-chain resolution.
 *
 * Both are $exists/status guarded so a duplicate run (cron + worker + lazy
 * screen load) is always a no-op. This gives fully unattended collection even on
 * serverless: the crypto loop never depends on anyone opening the UI.
 */
export async function GET(req: NextRequest) {
  if (!authorized(req)) return new Response("unauthorized", { status: 401 });
  try {
    await connectToDatabase();
    const roundStakesSettled = await settleRoundStakes();
    const positions = await reconcilePositions().catch(() => null);
    return Response.json({
      ok: true,
      roundStakesSettled,
      positionsReconciled: positions != null,
      at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[cron/sweep] failed", err);
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}