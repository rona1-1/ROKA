/**
 * src/app/api/health/route.ts — فحص صحة السيرفر.
 *
 * يُرجع: ok, database, mcpEndpoint, models, merger {base, healthy}, authRequired.
 */

import { NextResponse } from "next/server";
import { dbHealthy, ensureSchema } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSchema();
  const healthy = await dbHealthy();
  const merger = await mergerHealthy();

  return NextResponse.json({
    ok: true,
    database: healthy ? "turso-connected" : "turso-disconnected",
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({
      canonical: m.canonical,
      type: m.type,
      providers: m.providers,
    })),
    merger: {
      base: process.env.MERGER_API_BASE || "",
      healthy: merger,
    },
    authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
  });
}
