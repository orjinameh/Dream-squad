import { connectToDatabase } from "@/db/connect";
import { Match, ROUND_TIMINGS } from "@/db/models/Match";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { isAddress } from "viem";
import { CHARACTERS } from "@/game/characters";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const matchId = body.matchId as string | undefined;
  const address = body.address as string | undefined;
  const charId = body.charId as string | undefined;

  if (!matchId || matchId.length > 64 || !address || !isAddress(address)) {
    return jsonError(400, "valid matchId and address required");
  }
  if (charId && (typeof charId !== "string" || charId.length > 32 || !CHARACTERS.some((c) => c.id === charId))) {
    return jsonError(400, "invalid charId");
  }

  try {
    await connectToDatabase();
    const addr = normalizeAddress(address);

    // Atomic ready-claim: read-modify-save loses concurrent readys
    // (last-write-wins clears the first flag). Claim our flag + conditionally
    // transition WAITING→ACTIVE only when both are set.
    const isP1Claim = async () => {
      // Determine seat first (needs current doc).
      const cur = await Match.findById(matchId).lean();
      if (!cur) return null;
      if (cur.status !== "ACTIVE") return { error: "match not active" as const };
      const isP1 = normalizeAddress(cur.playerAddress) === addr;
      const isP2 = cur.player2Address && normalizeAddress(cur.player2Address) === addr;
      if (!isP1 && !isP2) return { error: "not a player in this match" as const };
      if (cur.roundPhase !== "WAITING") {
        // Late ready after open — record flag but don't transition.
        const field = isP1 ? "player1Ready" : "player2Ready";
        const upd: Record<string, unknown> = { [field]: true };
        if (charId) upd[isP1 ? "playerChar" : "player2Char"] = charId;
        await Match.findByIdAndUpdate(matchId, { $set: upd });
        const fresh = await Match.findById(matchId).lean();
        return { match: fresh, isP1 };
      }
      const field = isP1 ? "player1Ready" : "player2Ready";
      const upd: Record<string, unknown> = { [field]: true };
      if (charId) upd[isP1 ? "playerChar" : "player2Char"] = charId;
      await Match.findOneAndUpdate({ _id: matchId, status: "ACTIVE" }, { $set: upd });
      // Transition only when both flags are now true.
      const after = await Match.findOneAndUpdate(
        { _id: matchId, status: "ACTIVE", player1Ready: true, player2Ready: true, roundPhase: "WAITING" },
        {
          $set: {
            roundPhase: "ACTIVE",
            roundStartTime: new Date(),
            roundDeadline: new Date(Date.now() + ROUND_TIMINGS.ROUND_DURATION_MS),
            currentRound: 1,
          },
        },
        { new: true },
      ).lean();
      const fresh = after ?? await Match.findById(matchId).lean();
      return { match: fresh, isP1 };
    };

    const res = await isP1Claim();
    if (!res) return jsonError(404, "match not found");
    if ((res as { error?: string }).error) {
      const msg = (res as { error: string }).error;
      if (msg === "match not active") return jsonError(400, msg);
      return jsonError(403, msg);
    }
    const { match, isP1 } = res as { match: any; isP1: boolean };
    console.log(`[ready] match=${matchId} addr=${addr.slice(0,6)} isP1=${!!isP1} p1Ready=${match.player1Ready} p2Ready=${match.player2Ready} roundPhase=${match.roundPhase}`);

    // Perspective-safe response
    const myReady = isP1 ? match.player1Ready : match.player2Ready;
    const opponentReady = isP1 ? match.player2Ready : match.player1Ready;

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
