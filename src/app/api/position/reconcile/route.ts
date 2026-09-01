import { jsonError } from "@/lib/utils";
import { reconcilePositions } from "@/lib/ec/position";

/** POST /api/position/reconcile — settle EC positions whose windows resolved.
 *  Guarded by the admin token (same as matchmaking/clear). */
export async function POST(req: Request) {
  const adminToken = process.env.ADMIN_TOKEN;
  const auth = req.headers.get("x-admin-token");
  if (adminToken && auth !== adminToken) {
    return jsonError(401, "unauthorized");
  }
  try {
    const count = await reconcilePositions();
    return Response.json({ reconciled: count });
  } catch (err) {
    console.error("reconcile positions failed", err);
    return jsonError(500, "reconcile failed");
  }
}
