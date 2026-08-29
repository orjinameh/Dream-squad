import { connectToDatabase } from "@/db/connect";
import { Match, ROUND_TIMINGS } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const matchId = body.matchId as string | undefined;
  const address = body.address as string | undefined;
  const charId = body.charId as string | undefined;

  if (!matchId || !address || !address.startsWith("0x")) {
    return jsonError(400, "matchId and address required");
  }

  try {
    await connectToDatabase();
    const addr = normalizeAddress(address);

    const match = await Match.findById(matchId);
    if (!match) return jsonError(404, "match not found");
    if (match.status !== "ACTIVE") return jsonError(400, "match not active");

    // Determine player identity from connected wallet
    const isPlayer1 = normalizeAddress(match.playerAddress) === addr;
    const isPlayer2 = match.player2Address && normalizeAddress(match.player2Address) === addr;

    if (!isPlayer1 && !isPlayer2) {
      return jsonError(403, "not a player in this match");
    }

    // Mark as ready
    if (isPlayer1) {
      match.player1Ready = true;
      if (charId) match.playerChar = charId;
    } else {
      match.player2Ready = true;
      if (charId) match.player2Char = charId;
    }

    // If both ready, start the match
    if (match.player1Ready && match.player2Ready && match.roundPhase === "WAITING") {
      const now = new Date();
      match.roundPhase = "ACTIVE";
      match.roundStartTime = now;
      match.roundDeadline = new Date(now.getTime() + ROUND_TIMINGS.ROUND_DURATION_MS);
      match.currentRound = 1;
    }

    await match.save();
    console.log(`[ready] match=${matchId} addr=${addr.slice(0,6)} isP1=${!!isPlayer1} p1Ready=${match.player1Ready} p2Ready=${match.player2Ready} bothReady=${match.player1Ready && match.player2Ready} roundPhase=${match.roundPhase}`);

    // Perspective-safe response
    const myReady = isPlayer1 ? match.player1Ready : match.player2Ready;
    const opponentReady = isPlayer1 ? match.player2Ready : match.player1Ready;

    return Response.json({
      ready: true,
      myReady,
      opponentReady,
      bothReady: match.player1Ready && match.player2Ready,
      matchStatus: match.status,
      roundPhase: match.roundPhase,
      roundStartTime: match.roundStartTime,
      roundDeadline: match.roundDeadline,
    });
  } catch (err) {
    console.error("ready failed", err);
    return jsonError(500, "failed to set ready state");
  }
}
