/**
 * src/app/api/keys/[id]/route.ts — تعطيل/تنشيط/حذف مفتاح.
 * PATCH: تعطيل/تنشيط يدوي.
 * DELETE: حذف نهائي.
 */

import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/turso";
import { patchKey, deleteKey } from "@/lib/keypool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureSchema();
  const { id } = await params;
  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "JSON تالف" }, { status: 400 });
  }
  if (body?.status !== "active" && body?.status !== "disabled" && body?.status !== "exhausted") {
    return NextResponse.json({ error: "status غير صالح (active | disabled | exhausted)" }, { status: 400 });
  }
  await patchKey(id, { status: body.status });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureSchema();
  const { id } = await params;
  await deleteKey(id);
  return NextResponse.json({ ok: true });
}
