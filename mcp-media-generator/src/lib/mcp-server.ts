/**
 * src/lib/mcp-server.ts — خادم MCP مع الأدوات الخمس.
 *
 * يستخدم SDK الرسمي: McpServer + WebStandardStreamableHTTPServerTransport
 * (متوافق مع Next.js App Router الذي يستخدم Web Standard Request/Response).
 * الأدوات: generate_image, generate_video, merge_videos, get_task, list_media.
 * الأوصاف بالإنجليزية (العميل يقرأها)، النتائج تُصاغ بالعربية.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { ensureSchema, listRecentTasks, getTask } from "./turso";
import { runGeneration, runMerge, refreshTask } from "./generator";

export const SERVER_INFO = {
  name: "media-generator-mcp",
  version: "1.2.0",
} as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

/** يبني خادم MCP جديد بالأدوات الخمس مسجَّلة. */
export function buildMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // 1) generate_image
  server.tool(
    "generate_image",
    "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential key failover across all active keys). Returns the image URL if completed within the wait window, otherwise returns a task_id — call get_task every ~10 seconds until status is completed, then show the URL and stop polling.",
    {
      prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
      model: z
        .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
        .default("gpt-image-2-6/flare-text-to-image"),
      aspect_ratio: z
        .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
        .default("auto"),
      resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
      background: z
        .enum(["auto", "transparent", "opaque"])
        .default("auto")
        .describe("Only applied at 1K."),
      output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
      wait_seconds: z.number().int().min(0).max(240).default(90),
    },
    async (args) => {
      await ensureSchema();
      const r = await runGeneration({
        prompt: args.prompt,
        model: args.model,
        type: "image",
        aspect_ratio: args.aspect_ratio,
        resolution: args.resolution,
        background: args.background,
        output_format: args.output_format,
        wait_seconds: args.wait_seconds,
      });
      const text = formatImageResult(r);
      return {
        content: [{ type: "text" as const, text }],
        isError: r.status === "failed" && !r.noKeys ? true : false,
      };
    }
  );

  // 2) generate_video
  server.tool(
    "generate_video",
    "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video). The video takes minutes: short wait with live progress then a task_id — keep polling get_task every ~10 seconds until completed.",
    {
      prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
      image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
      model: z
        .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
        .default("grok-imagine-video-1-5-preview"),
      aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
      resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
      enable_audio: z.boolean().default(true),
      duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
      wait_seconds: z.number().int().min(0).max(240).default(25),
    },
    async (args) => {
      await ensureSchema();
      const r = await runGeneration({
        prompt: args.prompt,
        model: args.model,
        type: "video",
        image_url: args.image_url,
        aspect_ratio: args.aspect_ratio,
        resolution: args.resolution,
        enable_audio: args.enable_audio,
        duration: args.duration,
        wait_seconds: args.wait_seconds,
      });
      const text = formatVideoResult(r);
      return {
        content: [{ type: "text" as const, text }],
        isError: r.status === "failed" && !r.noKeys ? true : false,
      };
    }
  );

  // 3) merge_videos
  server.tool(
    "merge_videos",
    "Concatenate several clips into ONE final video in the given order. Pass 'urls' (public direct video URLs — e.g. generate_video output links) or 'task_ids' (COMPLETED video generation tasks — their result URLs are merged in this order; ideal after generating several clips). Merging is usually fast: short wait with live progress then a task_id — track it with get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
    {
      urls: z
        .array(z.string())
        .min(2)
        .max(10)
        .optional()
        .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
      task_ids: z
        .array(z.string())
        .min(2)
        .max(10)
        .optional()
        .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
      wait_seconds: z.number().int().min(0).max(240).default(60),
    },
    async (args) => {
      await ensureSchema();
      if (!args.urls && !args.task_ids) {
        return {
          content: [{ type: "text" as const, text: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." }],
          isError: true,
        };
      }
      const r = await runMerge({
        urls: args.urls,
        taskIds: args.task_ids,
        wait_seconds: args.wait_seconds,
      });
      const text = formatMergeResult(r);
      return { content: [{ type: "text" as const, text }], isError: r.status === "failed" };
    }
  );

  // 4) get_task
  server.tool(
    "get_task",
    "Track any task by id — image/video generation AND merge (reads the database and refreshes from the provider/service if still running). Poll it every ~10 seconds; when status is completed you'll find the result URLs — show them to the user and stop polling.",
    { task_id: z.string() },
    async (args) => {
      await ensureSchema();
      const r = await refreshTask(args.task_id);
      const found = await getTask(args.task_id);
      const text = formatGetTaskResult(r, found?.type);
      return {
        content: [{ type: "text" as const, text }],
        isError: r.status === "failed",
      };
    }
  );

  // 5) list_media
  server.tool(
    "list_media",
    "Recent images/videos/merges stored in the database with their URLs (no regeneration) — to recall previous results.",
    {
      type: z.enum(["image", "video", "merge"]).optional(),
      status: z.enum(["completed", "failed", "processing"]).optional(),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async (args) => {
      await ensureSchema();
      const rows = await listRecentTasks(args.limit, {
        type: args.type,
        status: args.status,
      });
      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: "لا توجد مهام مخزَّنة مطابقة." }] };
      }
      const lines = rows.map((t) => {
        const urls = t.result_urls_json ? JSON.parse(t.result_urls_json) : [];
        const urlLine = urls.length > 0 ? `\n  الروابط: ${urls.join(" | ")}` : "";
        return `- [${t.type}] ${t.id} — ${t.status} (${t.progress}%) — ${t.model}${urlLine}${t.error_message ? `\n  خطأ: ${t.error_message}` : ""}`;
      });
      return {
        content: [{ type: "text" as const, text: `أحدث ${rows.length} مهمة:\n\n${lines.join("\n\n")}` }],
      };
    }
  );

  return server;
}

/* ===================== صياغة الردود العربية ===================== */

interface R {
  taskId: string; status: string; progress: number; urls: string[];
  error?: string; noKeys?: boolean;
}

function formatImageResult(r: R): string {
  if (r.noKeys) return `❌ ${r.error}`;
  if (r.status === "completed" && r.urls.length > 0) {
    const url = r.urls[0];
    return `✅ تم توليد الصورة بنجاح\n\n![image](${url})\n\nالرابط المباشر: ${url}`;
  }
  if (r.status === "failed") return `❌ فشلت المهمة: ${r.error}`;
  return `⏳ المهمة قيد المعالجة — task_id: ${r.taskId}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

function formatVideoResult(r: R): string {
  if (r.noKeys) return `❌ ${r.error}`;
  if (r.status === "completed" && r.urls.length > 0) {
    return `✅ تم توليد الفيديو بنجاح\n\nالرابط المباشر: ${r.urls[0]}`;
  }
  if (r.status === "failed") return `❌ فشلت المهمة: ${r.error}`;
  return `⏳ المهمة قيد المعالجة — task_id: ${r.taskId} (${r.progress}%)\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

function formatMergeResult(r: R): string {
  if (r.status === "completed" && r.urls.length > 0) {
    return `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر: ${r.urls[0]}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
  }
  if (r.status === "failed") return `❌ فشلت المهمة: ${r.error}`;
  return `⏳ المهمة قيد المعالجة — task_id: ${r.taskId} (${r.progress}%)\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

function formatGetTaskResult(r: R, type?: string): string {
  if (r.status === "completed" && r.urls.length > 0) {
    const url = r.urls[0];
    if (type === "image") return `✅ تم توليد الصورة بنجاح\n\n![image](${url})\n\nالرابط المباشر: ${url}`;
    if (type === "merge") return `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر: ${url}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
    return `✅ تم توليد الفيديو بنجاح\n\nالرابط المباشر: ${url}`;
  }
  if (r.status === "failed") return `❌ فشلت المهمة: ${r.error}`;
  return `⏳ المهمة قيد المعالجة — task_id: ${r.taskId} (${r.progress}%)\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

/** يتحقق منBearer token إن ضُبط MCP_ACCESS_TOKEN. */
export function checkAuth(req: Request): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true;
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${token}`;
}

/** ينشئ transport جديد للجلسة (WebStandard — متوافق مع Next.js). */
export function createTransport(
  onSession?: (sessionId: string) => void
): WebStandardStreamableHTTPServerTransport {
  return new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: onSession,
  });
}
