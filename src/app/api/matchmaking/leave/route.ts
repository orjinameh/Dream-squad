import { connectToDatabase } from "@/db/connect";
import { MatchQueue } from "@/db/models/MatchQueue";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const address = body.address as string | undefined;

  if (!address || !address.startsWith("0x")) {
    return jsonError(400, "valid wallet address required");
  }

  try {
    await connectToDatabase();
    const addr = normalizeAddress(address);
    await MatchQueue.deleteMany({ address: addr, status: { $in: ["searching", "matched"] } });
    return Response.json({ status: "left" });
  } catch (err) {
    console.error("matchmaking leave failed", err);
    return jsonError(500, "failed to leave queue");
  }
}
