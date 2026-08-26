import { connectToDatabase } from "@/db/connect";
import { Match } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";
import { z } from "zod";
import { isAddress } from "viem";

export const dynamic = "force-dynamic";

const resultSchema = z.object({
  matchId: z.string().min(1),
  playerAddress: z.string().refine((v) => isAddress(v), "invalid address"),
});

/**
 * Legacy result endpoint.
 * Match finalization now happens in the predict route.
 * This endpoint is retained for backwards compatibility but
 * ignores client-supplied scores/rounds/winner.
 * It only checks if the match is already completed and returns the server state.
 */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError(400, "body must be JSON"); }

  const parsed = resultSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, `validation failed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const input = parsed.data;

  try {
    await connectToDatabase();

    const match = await Match.findById(input.matchId);
    if (!match) return jsonError(404, "match not found");

    // Return server-authoritative result — never trust client scores
    return Response.json({
      matchId: match._id,
      winner: match.winner,
      playerScore: match.playerScore,
      rivalScore: match.rivalScore,
      status: match.status,
      statsProcessed: match.statsProcessed,
    });
  } catch (err) {
    console.error("result query failed", err);
    return jsonError(500, "failed to query result");
  }
}
