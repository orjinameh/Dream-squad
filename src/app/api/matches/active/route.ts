import { connectToDatabase } from "@/db/connect";
import { Match } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");
  if (!address || !address.startsWith("0x")) return jsonError(400, "address required");

  try {
    await connectToDatabase();
    const addr = normalizeAddress(address);

    const match = await Match.findOne({
      status: "ACTIVE",
      $or: [{ playerAddress: addr }, { player2Address: addr }],
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!match) return Response.json({ active: false });

    return Response.json({
      active: true,
      matchId: match._id,
      mode: match.mode,
      totalRounds: match.totalRounds,
      currentRound: match.currentRound,
      playerScore: match.playerScore,
      rivalScore: match.rivalScore,
      opponentType: match.opponentType ?? "bot",
      player1Address: match.playerAddress,
      player2Address: match.player2Address,
      player2Char: match.player2Char,
      player1Ready: match.player1Ready,
      player2Ready: match.player2Ready,
    });
  } catch (err) {
    console.error("active match check failed", err);
    return jsonError(500, "failed to check active match");
  }
}
