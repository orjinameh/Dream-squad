import { createPublicClient, http } from "viem";
import { SOMNIA_CHAIN, SPOT_POOL_ABI, OPERATOR_ADDRESS, IS_OPERATOR_AUTHORIZED_ABI } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pool = url.searchParams.get("pool");
  const owner = url.searchParams.get("owner");
  if (!pool || !owner) return Response.json({ error: "pool and owner required" }, { status: 400 });

  const client = createPublicClient({ chain: SOMNIA_CHAIN, transport: http() });

  try {
    const authorized = await client.readContract({
      address: pool as `0x${string}`,
      abi: [...SPOT_POOL_ABI, ...IS_OPERATOR_AUTHORIZED_ABI] as unknown as typeof IS_OPERATOR_AUTHORIZED_ABI,
      functionName: "isOperatorAuthorized",
      args: [owner as `0x${string}`, OPERATOR_ADDRESS, "0x80054449"],
    });
    return Response.json({ authorized });
  } catch {
    return Response.json({ authorized: false });
  }
}
