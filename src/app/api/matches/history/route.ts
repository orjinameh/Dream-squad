import { connectToDatabase } from "@/db/connect";
import { Match } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 50);

  if (!address) return jsonError(400, "address required");

  try {
    await connectToDatabase();
    const addr = normalizeAddress(address);

    const matches = await Match.find({
      $or: [{ playerAddress: addr }, { player2Address: addr }],
      status: "COMPLETED",
    })
      .sort({ completedAt: -1 })
      .limit(limit)
      .lean();

    return Response.json({
      matches: matches.map((m) => {
        const isPlayer2 = normalizeAddress(m.player2Address || "") === addr;
        const isBot = m.opponentType === "bot";

        return {
          matchId: m._id,
          mode: m.mode,
          playerChar: isPlayer2 ? (m.player2Char || m.rivalChar) : m.playerChar,
          rivalName: isBot ? m.rivalName : (isPlayer2 ? "Player 1" : (m.player2Address ? `${m.player2Address.slice(0, 6)}...${m.player2Address.slice(-4)}` : m.rivalName)),
          rivalChar: isPlayer2 ? m.playerChar : (m.player2Char || m.rivalChar),
          playerScore: isPlayer2 ? m.rivalScore : m.playerScore,
          rivalScore: isPlayer2 ? m.playerScore : m.rivalScore,
          winner: isPlayer2
            ? (m.winner === "rival" ? "player" : m.winner === "player" ? "rival" : "draw")
            : m.winner,
          totalRounds: m.totalRounds,
          opponentType: m.opponentType,
          botDifficulty: m.botDifficulty,
          completedAt: m.completedAt?.toISOString(),
          rounds: m.rounds?.map((r) => ({
            roundNum: r.roundNum,
            playerPrediction: isPlayer2 ? r.rivalPrediction : r.playerPrediction,
            rivalPrediction: isPlayer2 ? r.playerPrediction : r.rivalPrediction,
            actual: r.actual,
            playerCorrect: isPlayer2 ? r.rivalCorrect : r.playerCorrect,
            rivalCorrect: isPlayer2 ? r.playerCorrect : r.rivalCorrect,
          })) ?? [],
          playerHP: isPlayer2 ? m.rivalHP : m.playerHP,
          rivalHP: isPlayer2 ? m.playerHP : m.rivalHP,
        };
      }),
    });
  } catch (err) {
    console.error("match history failed", err);
    return jsonError(500, "failed to fetch match history");
  }
}
