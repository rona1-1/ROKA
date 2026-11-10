/**
 * src/app/mcp/route.ts — مسار خادم MCP (Streamable HTTP).
 *
 * runtime = "nodejs" و dynamic = "force-dynamic" (مطلوب للـ streaming).
 * POST: رسائل JSON-RPC (initialize, tools/list, tools/call, notifications/initialized).
 * DELETE: إنهاء الجلسة.
 * إن ضُبط MCP_ACCESS_TOKEN يُطلب Bearer token.
 *
 * نستخدم WebStandardStreamableHTTPServerTransport لأن Next.js App Router
 * يتعامل مع Web Standard Request/Response (وليس Node IncomingMessage).
 */

import { NextRequest, NextResponse } from "next/server";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer, createTransport, checkAuth } from "@/lib/mcp-server";
import { ensureSchema } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// خريطة الجلسات النشطة: transport لكل sessionId
const transports = new Map<string, ReturnType<typeof createTransport>>();

export async function POST(req: NextRequest): Promise<Response> {
  // فحص المصادقة
  if (!checkAuth(req)) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: Bearer token required" }, id: null },
      { status: 401 }
    );
  }

  await ensureSchema();

  // قراءة الجسم مرة واحدة — SDK يستهلكه
  const rawBody = await req.text();
  let body: any;
  try { body = JSON.parse(rawBody); } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null },
      { status: 400 }
    );
  }

  // هل هي رسالة initialize؟ — ننشئ جلسة جديدة
  if (isInitializeRequest(body)) {
    const server = buildMcpServer();
    const transport = createTransport((sessionId: string) => {
      transports.set(sessionId, transport);
    });
    await server.connect(transport);
    // نبني Request جديدًا بالجسم الذي قرأناه (لأن النص قد استُهلك)
    const fakeReq = new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: rawBody,
    });
    return await transport.handleRequest(fakeReq);
  }

  // رسالة عادية — نحتاج sessionId
  const sessionId = req.headers.get("mcp-session-id") || "";
  const transport = transports.get(sessionId);
  if (!transport) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid session. Initialize first." }, id: body?.id ?? null },
      { status: 400 }
    );
  }
  const fakeReq = new Request(req.url, {
    method: "POST",
    headers: req.headers,
    body: rawBody,
  });
  return await transport.handleRequest(fakeReq);
}

export async function DELETE(req: NextRequest): Promise<Response> {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sessionId = req.headers.get("mcp-session-id") || "";
  const transport = transports.get(sessionId);
  if (transport) {
    try { await transport.close(); } catch {}
    transports.delete(sessionId);
  }
  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function GET(): Promise<Response> {
  // GET على /mcp غير مدعوم في Streamable HTTP (نحتاج POST فقط للرسائل)
  return NextResponse.json(
    { error: "Method GET not allowed on /mcp. Use POST with JSON-RPC." },
    { status: 405 }
  );
}
