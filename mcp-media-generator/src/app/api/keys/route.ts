/**
 * src/app/api/keys/route.ts — إدارة المفاتيح.
 * GET: قائمة كاملة مع الإخفاء الإلزامي.
 * POST: إضافة مفتاح {provider, api_key, label?} مع رفض التكرار.
 */

import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/turso";
import { insertKey, listKeys, maskKey } from "@/lib/keypool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSchema();
  const rows = await listKeys();
  return NextResponse.json({
    keys: rows.map((k) => ({
      id: k.id,
      provider: k.provider,
      label: k.label,
      masked: maskKey(k.api_key),
      status: k.status,
      usage_count: k.usage_count,
      success_count: k.success_count,
      fail_count: k.fail_count,
      last_used_at: k.last_used_at,
      last_checked_at: k.last_checked_at,
      last_error: k.last_error,
      created_at: k.created_at,
    })),
  });
}

export async function POST(req: NextRequest) {
  await ensureSchema();
  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "JSON تالف" }, { status: 400 });
  }
  const provider = body?.provider;
  const api_key = body?.api_key;
  const label = body?.label;
  if (!provider || !api_key) {
    return NextResponse.json({ error: "provider و api_key مطلوبان" }, { status: 400 });
  }
  if (provider !== "kie" && provider !== "cometapi") {
    return NextResponse.json({ error: "provider غير معروف (kie أو cometapi فقط)" }, { status: 400 });
  }
  try {
    const row = await insertKey({ provider, api_key: String(api_key), label: label ? String(label) : undefined });
    return NextResponse.json({
      ok: true,
      key: {
        id: row.id, provider: row.provider, label: row.label, masked: maskKey(row.api_key), status: row.status,
      },
    }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
}
