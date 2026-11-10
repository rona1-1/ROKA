/**
 * src/lib/providers/kie.ts — مزود kie.ai (المزود الأساسي).
 *
 * Jobs API الموحَّد:
 *   POST https://api.kie.ai/api/v1/jobs/createTask
 *     Authorization: Bearer <key>
 *     {"model": "<providerModel>", "input": { ... }}
 *     → {"code":200,"data":{"taskId":"..."}}
 *
 *   GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=<id>
 *     → {"code":200,"data":{
 *         "state":"waiting|queuing|generating|success|fail",
 *         "resultJson":"{\"resultUrls\":[\"https://...\"]}",  // نص JSON داخل JSON!
 *         "failMsg":"..."
 *       }}
 *
 * ملاحظة: resultJson نَص يحتاج JSON.parse ثانيًا. اتبع توثيق docs.kie.ai عند أي اختلاف.
 */

import { ProviderError } from "../errors";
import type {
  GenerateImageInput,
  GenerateVideoInput,
  ProviderAdapter,
} from "./types";

const KIE_BASE = "https://api.kie.ai";

async function callKie(
  key: string,
  method: "POST" | "GET",
  path: string,
  body?: unknown
): Promise<any> {
  const url = `${KIE_BASE}${path}`;
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
    // خطأ شبكة/timeout → مؤقت
    throw new ProviderError(0, `network error: ${(e as Error).message}`);
  }

  const text = await resp.text();
  if (!resp.ok) {
    throw new ProviderError(
      resp.status,
      `kie HTTP ${resp.status}`,
      text
    );
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderError(resp.status, "kie response not JSON", text);
  }

  // kie يرجع {code:200, data:...} — إن كان code != 200 فهو خطأ
  if (json.code !== 200 && json.code !== undefined) {
    throw new ProviderError(
      resp.status,
      `kie code ${json.code}: ${json.msg || json.message || ""}`,
      text
    );
  }
  return json;
}

/** يبني payload الطلب لـ createTask حسب النوع. */
function buildInput(
  type: "image" | "video",
  providerModel: string,
  input: GenerateImageInput | GenerateVideoInput
): Record<string, unknown> {
  if (type === "image") {
    const i = input as GenerateImageInput;
    return {
      prompt: i.prompt,
      aspectRatio: i.aspect_ratio ?? "auto",
      resolution: i.resolution ?? "1K",
      background: i.background ?? "auto",
      outputFormat: i.output_format ?? "png",
    };
  }
  const i = input as GenerateVideoInput;
  const payload: Record<string, unknown> = {
    prompt: i.prompt,
    aspectRatio: i.aspect_ratio ?? "auto",
    resolution: i.resolution ?? "480p",
    enableAudio: i.enable_audio ?? true,
    duration: i.duration ?? 8,
  };
  if (i.image_url) payload.imageUrl = i.image_url;
  return payload;
}

export const kieProvider: ProviderAdapter = {
  async createTask(key, providerModel, type, input) {
    const json = await callKie(key, "POST", "/api/v1/jobs/createTask", {
      model: providerModel,
      input: buildInput(type, providerModel, input),
    });
    const taskId = json?.data?.taskId;
    if (!taskId) {
      throw new ProviderError(200, "kie: missing taskId in response", JSON.stringify(json));
    }
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key, providerTaskId) {
    const json = await callKie(
      key,
      "GET",
      `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`
    );
    const data = json?.data ?? {};
    const state = String(data.state ?? "").toLowerCase();

    // خريطة الحالات
    if (state === "success" || state === "succeeded" || state === "completed") {
      // resultJson نَص يحتاج JSON.parse ثانيًا
      let urls: string[] = [];
      const rj = data.resultJson;
      if (typeof rj === "string") {
        try {
          const parsed = JSON.parse(rj);
          urls = Array.isArray(parsed?.resultUrls)
            ? parsed.resultUrls
            : Array.isArray(parsed?.urls)
              ? parsed.urls
              : [];
        } catch {
          urls = [];
        }
      } else if (rj && typeof rj === "object") {
        urls = Array.isArray(rj.resultUrls)
          ? rj.resultUrls
          : Array.isArray(rj.urls)
            ? rj.urls
            : [];
      }
      // بعض الاستجابات قد تضع الروابط مباشرة في data.resultUrls
      if (urls.length === 0 && Array.isArray(data.resultUrls)) {
        urls = data.resultUrls;
      }
      if (urls.length === 0) {
        return {
          status: "completed" as const,
          urls: [],
          error: "kie: success state but no URLs found",
        };
      }
      return { status: "completed" as const, urls };
    }

    if (state === "fail" || state === "failed" || state === "error") {
      const msg = data.failMsg || data.error || "kie: task failed";
      return { status: "failed" as const, error: String(msg) };
    }

    // waiting|queuing|generating → processing
    const progress = mapKieProgress(state);
    return { status: "processing" as const, progress };
  },
};

/** يقدّر نسبة التقدم من حالة kie. */
function mapKieProgress(state: string): number {
  switch (state) {
    case "waiting": return 5;
    case "queuing": return 15;
    case "generating": return 50;
    default: return 10;
  }
}
