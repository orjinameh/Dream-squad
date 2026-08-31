import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const ts = Date.now();
  console.log(`[health] probe at ${ts} from ${req.headers.get("user-agent") ?? "unknown"}`);
  return NextResponse.json({
    ok: true,
    ts,
    port: process.env.PORT ?? "unset",
    pid: process.pid,
  });
}
