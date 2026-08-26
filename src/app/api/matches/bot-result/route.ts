import { connectToDatabase } from "@/db/connect";
import { Match, type StatsProcessedStatus } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

/**
 * Legacy bot-result endpoint.
 * Combat and match resolution now happen in the predict route.
 * This endpoint is retained for backwards compatibility but
 * does NOT process stats if statsProcessed is already COMPLETE.
 */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError(400, "body must be JSON"); }

  const { matchId } = body as { matchId?: string };
  if (!matchId) return jsonError(400, "matchId required");

  try {
    await connectToDatabase();
    const match = await Match.findById(matchId);
    if (!match) return jsonError(404, "match not found");

    // Already processed — idempotent
    if (match.statsProcessed === "COMPLETE") {
      return Response.json({ ok: true, winner: match.winner, deduped: true });
    }

    // Still processing or pending — the predict route handles actual resolution
    return Response.json({ ok: true, winner: match.winner, status: match.status, statsProcessed: match.statsProcessed });
  } catch (err) {
    console.error("bot-result failed", err);
    return jsonError(500, "failed to process bot result");
  }
}
