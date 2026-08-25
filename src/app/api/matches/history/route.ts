import { connectToDatabase } from "@/db/connect";
import { Match } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "10", 10), 50);

  if (!address) return jsonError(400, "address required");

  try {
    await connectToDatabase();
    const addr = normalizeAddress(address);

    const matches = await Match.find({ playerAddress: addr, status: "COMPLETED" })
      .sort({ completedAt: -1 })
      .limit(limit)
      .lean();

    return Response.json({
      matches: matches.map((m) => ({
        matchId: m._id,
        mode: m.mode,
        playerChar: m.playerChar,
        rivalName: m.rivalName,
        rivalChar: m.rivalChar,
        playerScore: m.playerScore,
        rivalScore: m.rivalScore,
        winner: m.winner,
        totalRounds: m.totalRounds,
        completedAt: m.completedAt?.toISOString(),
      })),
    });
  } catch (err) {
    console.error("match history failed", err);
    return jsonError(500, "failed to fetch match history");
  }
}
