import { connectToDatabase } from "@/db/connect";
import { normalizeAddress } from "@/lib/addresses";
import { jsonError } from "@/lib/utils";
import { findActivePosition, openPosition, PositionError } from "@/lib/ec/position";
import { positionInfo } from "@/lib/ec/escrow";
import { z } from "zod";
import { isAddress, formatUnits } from "viem";
import { EC_COLLATERAL_DECIMALS, ESCROW_ADDRESS } from "@/lib/ec/config";

const openSchema = z.object({
  address: z.string().refine((v) => isAddress(v), "invalid address"),
  direction: z.enum(["UP", "DOWN"]),
  market: z.enum(["BTC", "ETH"]),
  amount: z.number().positive(),
});

/** GET /api/position?address=0x… — the wallet's active EC position. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("address") ?? "";
  if (!isAddress(raw)) return jsonError(400, "address query param required");
  const address = normalizeAddress(raw);
  try {
    await connectToDatabase();
    const pos = await findActivePosition(address.toLowerCase());
    if (!pos) return Response.json({ position: null });

    // Merge live on-chain stake state for the position's windowId.
    let onchain = null;
    if (pos.windowId) {
      const info = await positionInfo(pos.windowId as `0x${string}`).catch(() => null);
      if (info) {
        onchain = {
          open: info.open,
          settled: info.settled,
          won: info.won, // 0 pending / 1 won / 2 lost
          balanceRaw: info.balance.toString(),
          balance: formatUnits(info.balance, EC_COLLATERAL_DECIMALS),
          windowOpen: Number(info.windowOpen),
          windowClose: Number(info.windowClose),
        };
      }
    }

    return Response.json({
      position: {
        id: pos._id,
        direction: pos.direction,
        market: pos.market,
        amount: pos.amount,
        status: pos.status,
        arenaOpen: pos.arenaOpen ?? null,
        windowOpenAt: pos.windowOpenAt?.toISOString() ?? null,
        windowCloseAt: pos.windowCloseAt?.toISOString() ?? null,
        matchCount: pos.matchCount,
        escrowAddress: ESCROW_ADDRESS,
        windowId: pos.windowId ?? null,
        onchain,
      },
    });
  } catch (err) {
    console.error("get position failed", err);
    return jsonError(500, "failed to load position");
  }
}

/** POST /api/position — open a new EC position (financial stake). */
export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError(400, "body must be JSON"); }
  const parsed = openSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, `validation failed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const input = parsed.data;
  try {
    const result = await openPosition({
      address: normalizeAddress(input.address).toLowerCase(),
      direction: input.direction,
      market: input.market,
      amount: input.amount,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof PositionError) return jsonError(err.status, err.message);
    console.error("open position failed", err);
    return jsonError(500, "failed to open position");
  }
}
