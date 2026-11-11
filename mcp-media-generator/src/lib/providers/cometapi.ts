/**
 * src/lib/providers/cometapi.ts — مزود CometAPI (المزود الثاني).
 *
 * صور متزامنة عبر نقطة images المتوافقة مع OpenAI تعيد الرابط/b64_json فورًا.
 * فيديو عبر نقطة المهام غير المتزامنة بنفس نمط create/check.
 *
 * ملاحظة: لا يوجد مفتاح CometAPI في المعطيات — الكود جاهز لكنه يحتاج مفتاحًا للعمل.
 * اتبع توثيق api.cometapi.com الحالي عند أي اختلاف.
 */

import { ProviderError } from "../errors";
import type {
  GenerateImageInput,
  GenerateVideoInput,
  ProviderAdapter,
} from "./types";

const COMET_BASE = "https://api.cometapi.com";

async function callComet(
  key: string,
  method: "POST" | "GET",
  path: string,
  body?: unknown
): Promise<any> {
  const url = `${COMET_BASE}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  };
  if (method === "POST" && body !== undefined) {
    init.body = JSON.stringify(body);
  }

  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (e) {
    throw new ProviderError(0, `network error: ${(e as Error).message}`);
  }
  const text = await resp.text();
  if (!resp.ok) {
    throw new ProviderError(resp.status, `comet HTTP ${resp.status}`, text);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(resp.status, "comet response not JSON", text);
  }
}

export const cometapiProvider: ProviderAdapter = {
  // صور متزامنة (نمط OpenAI /v1/images/generations)
  async createImageSync(key, providerModel, input) {
    const i = input as GenerateImageInput;
    const json = await callComet(key, "POST", "/v1/images/generations", {
      model: providerModel,
      prompt: i.prompt,
      size: mapAspectToSize(i.aspect_ratio),
      response_format: "url",
    });
    const data = json?.data ?? [];
    const urls: string[] = [];
    for (const item of data) {
      if (item.url) urls.push(item.url);
      else if (item.b64_json) {
        // b64 → data URL (نبقى لا ننزّل الملف — نعيد data URL كرابط)
        urls.push(`data:image/png;base64,${item.b64_json}`);
      }
    }
    if (urls.length === 0) {
      throw new ProviderError(200, "comet: no image URL in response", JSON.stringify(json));
    }
    return { urls };
  },

  async createTask(key, providerModel, type, input) {
    // فيديو عبر نقطة مهام غير متزامنة (نفس نمط create/check)
    const i = input as GenerateVideoInput;
    const payload: Record<string, unknown> = {
      model: providerModel,
      prompt: i.prompt,
      aspect_ratio: i.aspect_ratio ?? "auto",
      resolution: i.resolution ?? "480p",
      enable_audio: i.enable_audio ?? true,
      duration: i.duration ?? 8,
    };
    if (i.image_url) payload.image_url = i.image_url;

    const json = await callComet(key, "POST", "/v1/videos/generations", payload);
    const taskId = json?.id || json?.data?.id || json?.task_id || json?.data?.task_id;
    if (!taskId) {
      throw new ProviderError(200, "comet: missing task id in response", JSON.stringify(json));
    }
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key, providerTaskId) {
    const json = await callComet(
      key,
      "GET",
      `/v1/videos/generations/${encodeURIComponent(providerTaskId)}`
    );
    const data = json?.data ?? json;
    const status = String(data.status ?? data.state ?? "").toLowerCase();

    if (status === "completed" || status === "succeeded" || status === "success") {
      const urls: string[] = [];
      if (data.url) urls.push(data.url);
      if (data.video_url) urls.push(data.video_url);
      if (Array.isArray(data.urls)) urls.push(...data.urls);
      if (Array.isArray(data.results)) {
        for (const r of data.results) {
          if (r.url) urls.push(r.url);
          if (r.video_url) urls.push(r.video_url);
        }
      }
      return { status: "completed" as const, urls };
    }
    if (status === "failed" || status === "error") {
      return { status: "failed" as const, error: data.error || data.message || "comet: task failed" };
    }
    const progress = typeof data.progress === "number"
      ? (data.progress <= 1 ? data.progress * 100 : data.progress)
      : 10;
    return { status: "processing" as const, progress };
  },
};

/** يحوّل aspect_ratio إلى size متوافق مع OpenAI. */
function mapAspectToSize(ar?: string): string {
  switch (ar) {
    case "1:1": return "1024x1024";
    case "3:2": case "16:9": return "1792x1024";
    case "2:3": case "9:16": return "1024x1792";
    default: return "1024x1024";
  }
}
