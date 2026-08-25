import { createPublicClient, http } from "viem";
import { SOMNIA_CHAIN } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const hash = url.searchParams.get("hash");
  if (!hash) return Response.json({ error: "hash required" }, { status: 400 });

  const client = createPublicClient({ chain: SOMNIA_CHAIN, transport: http() });

  try {
    const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
    return Response.json({ confirmed: !!receipt, status: receipt?.status });
  } catch {
    return Response.json({ confirmed: false });
  }
}
