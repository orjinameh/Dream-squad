import { jsonError } from "@/lib/utils";
import { reconcilePositions } from "@/lib/ec/position";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Guard against overlapping runs (a second cron ping arriving while the first
// is still settling). On-chain settleWindow already reverts on a double-settle,
// but this avoids wasted gas/errors from concurrent sweeps.
let inFlight = false;

/** POST /api/position/reconcile — settle EC positions whose windows resolved.
 *  Guarded by the admin token (same as matchmaking/clear). Intended to be called
 *  on a ~15s cadence by an external scheduler (GitHub Actions cron). */
export async function POST(req: Request) {
  const adminToken = process.env.ADMIN_TOKEN;
  const auth = req.headers.get("x-admin-token");
  if (adminToken && auth !== adminToken) {
    return jsonError(401, "unauthorized");
  }
  if (inFlight) {
    return Response.json({ reconciled: 0, skipped: "in-flight" });
  }
  inFlight = true;
  try {
    const count = await reconcilePositions();
    return Response.json({ reconciled: count });
  } catch (err) {
    console.error("reconcile positions failed", err);
    return jsonError(500, "reconcile failed");
  } finally {
    inFlight = false;
  }
}
