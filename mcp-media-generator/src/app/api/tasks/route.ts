/**
 * src/app/api/tasks/route.ts — قائمة أحدث المهام (للواجهة).
 * GET: ?limit=20&type=image&status=completed
 */

import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, listRecentTasks, taskStats } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await ensureSchema();
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") || 20);
  const type = url.searchParams.get("type") || undefined;
  const status = url.searchParams.get("status") || undefined;
  const [rows, stats] = await Promise.all([
    listRecentTasks(limit, { type, status }),
    taskStats(),
  ]);
  return NextResponse.json({
    stats,
    tasks: rows.map((t) => ({
      id: t.id,
      type: t.type,
      status: t.status,
      progress: t.progress,
      model: t.model,
      prompt: t.prompt.slice(0, 120),
      provider: t.provider,
      result_urls: t.result_urls_json ? JSON.parse(t.result_urls_json) : [],
      error_message: t.error_message,
      attempts: t.attempts_json ? JSON.parse(t.attempts_json) : [],
      created_at: t.created_at,
      completed_at: t.completed_at,
    })),
  });
}
