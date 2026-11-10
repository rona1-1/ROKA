/**
 * src/lib/generator.ts — منسّق التوليد بالتبديل التسلسلي.
 *
 * التدفق (مطابق لقسم 6 من المواصفة):
 *  1. وحّد اسم الموديل عبر aliases — غير معروف → خطأ معطيات فوري.
 *  2. getKeyPool(providers الموديل) — فارغ → رد no_keys.
 *  3. سجّل المهمة في Turso قبل أي نداء خارجي.
 *  4. جرّب المرشحين بالترتيب حتى نجاح الإنشاء.
 *  5. أثناء نافذة الانتظار: استعلم checkTask كل 3 ثوانٍ وأبث progress notifications.
 *  6. اكتمل → خزّن النتائج و completed. فشل مفتاح/رصيد → أعد الإنشاء على التالي بنفس task_id.
 *  7. انتهت النافذة ولم تظهر → أعد المهمة processing مع task_id.
 *
 * قاعدة «لا توقف أبدًا» (4.3):
 *  - فشل في منتصف المهمة برسالة مفتاح/رصيد → أعد الإنشاء على المفتاح التالي بنفس task_id.
 *  - فشل على كل المفاتيح → المهمة تبقى processing برسالة «بانتظار توفر مفتاح صالح…».
 *  - النموذج لا يرى أخطاء المفاتيح/الرصيد أبدًا.
 */

import { randomUUID } from "node:crypto";
import {
  type AttemptRecord,
  getTask,
  insertTask,
  updateTask,
} from "./turso";
import { getKeyPool, bumpKeyCounters, type KeyRow } from "./keypool";
import { resolveModel, type ModelDef } from "./models";
import {
  ProviderError,
  classifyProviderError,
  shouldSwitchKey,
  shouldDisableKey,
  shouldMarkExhausted,
} from "./errors";
import { kieProvider } from "./providers/kie";
import { cometapiProvider } from "./providers/cometapi";
import type { ProviderAdapter } from "./providers/types";

export interface GenerateArgs {
  prompt: string;
  model?: string;
  type: "image" | "video";
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  image_url?: string;
  enable_audio?: boolean;
  duration?: number;
  wait_seconds?: number;
}

export interface GenerateResult {
  taskId: string;
  status: "completed" | "processing" | "failed";
  progress: number;
  urls: string[];
  error?: string;
  /** هل هذا رد no_keys (لا مفاتيح نشطة) — يُعاد للمستخدم مباشرة. */
  noKeys?: boolean;
}

const adapters: Record<string, ProviderAdapter> = {
  kie: kieProvider,
  cometapi: cometapiProvider,
};

/** الجيل الرئيسي — يُستدعى من أداة generate_image / generate_video. */
export async function runGeneration(args: GenerateArgs): Promise<GenerateResult> {
  // 1. توحيد الموديل
  const model: ModelDef | null = resolveModel(args.model || (args.type === "image"
    ? "gpt-image-2-6/flare-text-to-image"
    : "grok-imagine-video-1-5-preview"));
  if (!model || model.type !== args.type) {
    return {
      taskId: "",
      status: "failed",
      progress: 0,
      urls: [],
      error: `موديل غير معروف أو غير متوافق مع نوع '${args.type}': ${args.model}`,
    };
  }

  // 2. تجمّع المفاتيح بالترتيب التسلسلي
  const pool = await getKeyPool(model.providers);
  if (pool.length === 0) {
    return {
      taskId: "",
      status: "failed",
      progress: 0,
      urls: [],
      noKeys: true,
      error: `لا توجد مفاتيح نشطة لخدمة ${model.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    };
  }

  // 3. تسجيل المهمة في Turso قبل أي نداء خارجي
  const taskId = randomUUID();
  const paramsJson = JSON.stringify({
    prompt: args.prompt,
    aspect_ratio: args.aspect_ratio,
    resolution: args.resolution,
    background: args.background,
    output_format: args.output_format,
    image_url: args.image_url,
    enable_audio: args.enable_audio,
    duration: args.duration,
    wait_seconds: args.wait_seconds,
  });
  await insertTask({
    id: taskId,
    model: model.canonical,
    type: args.type,
    prompt: args.prompt,
    params_json: paramsJson,
    status: "pending",
  });

  // 4. محاولة الإنشاء على المرشحين بالترتيب
  const input = buildInput(args);
  let created: { provider: string; keyId: string; providerTaskId: string } | null = null;

  for (const key of pool) {
    const adapter = adapters[key.provider];
    if (!adapter) continue;
    const providerModel = model.providerModel[key.provider as "kie" | "cometapi"];

    try {
      // محاولة صورة متزامنة أولًا إن كان المزود يدعمها
      if (args.type === "image" && adapter.createImageSync) {
        try {
          const sync = await adapter.createImageSync(key.api_key, providerModel, input as any);
          await bumpKeyCounters(key.id, { ok: true });
          const attempt: AttemptRecord = {
            provider: key.provider, keyId: key.id, keyLabel: key.label || key.provider,
            ok: true, at: new Date().toISOString(),
          };
          await updateTask(taskId, {
            provider: key.provider,
            key_id: key.id,
            status: "completed",
            progress: 100,
            result_urls_json: JSON.stringify(sync.urls),
            attempt,
          });
          return { taskId, status: "completed", progress: 100, urls: sync.urls };
        } catch (e) {
          // فشل الصورة المتزامنة — جرّب createTask العادية
          if (e instanceof ProviderError && classifyProviderError(e.status, e.message, e.body) === "params") {
            // خطأ معطيات — لا فائدة من التبديل
            throw e;
          }
          // وإلا فتابع لمحاولة createTask
        }
      }

      // إنشاء مهمة غير متزامنة
      const r = await adapter.createTask(key.api_key, providerModel, args.type, input as any);
      await bumpKeyCounters(key.id, { ok: true });
      created = { provider: key.provider, keyId: key.id, providerTaskId: r.providerTaskId };
      await updateTask(taskId, {
        provider: key.provider,
        provider_task_id: r.providerTaskId,
        key_id: key.id,
        status: "processing",
        progress: 10,
        attempt: {
          provider: key.provider, keyId: key.id, keyLabel: key.label || key.provider,
          ok: true, at: new Date().toISOString(),
        },
      });
      break;
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError(0, (e as Error).message);
      const ec = classifyProviderError(pe.status, pe.message, pe.body);
      await bumpKeyCounters(key.id, { ok: false, errorClass: ec, error: pe.message });
      await updateTask(taskId, {
        attempt: {
          provider: key.provider, keyId: key.id, keyLabel: key.label || key.provider,
          ok: false, errorClass: ec, error: pe.message, at: new Date().toISOString(),
        },
      });
      // params → توقف فوري
      if (!shouldSwitchKey(ec)) {
        await updateTask(taskId, { status: "failed", error_message: pe.message });
        return { taskId, status: "failed", progress: 0, urls: [], error: pe.message };
      }
      // وإلا تابع للمفتاح التالي
    }
  }

  if (!created) {
    // فشل الإنشاء على كل المفاتيح → المهمة تبقى processing بانتظار توفر مفتاح صالح
    await updateTask(taskId, {
      status: "processing",
      progress: 0,
      error_message: "بانتظار توفر مفتاح صالح…",
    });
    return {
      taskId,
      status: "processing",
      progress: 0,
      urls: [],
    };
  }

  // 5. نافذة الانتظار + بث التقدم
  const waitSeconds = Math.max(0, Math.min(240, args.wait_seconds ?? (args.type === "image" ? 90 : 25)));
  const result = await waitForCompletion(taskId, created.provider, created.keyId, created.providerTaskId, model, waitSeconds);

  return result;
}

/** يبني كائن الإدخال الموحَّد من GenerateArgs. */
function buildInput(args: GenerateArgs) {
  return {
    prompt: args.prompt,
    aspect_ratio: args.aspect_ratio,
    resolution: args.resolution,
    background: args.background,
    output_format: args.output_format,
    image_url: args.image_url,
    enable_audio: args.enable_audio,
    duration: args.duration,
  };
}

/** نافذة انتظار مع بث التقدم — تستعلم checkTask كل 3 ثوانٍ. */
async function waitForCompletion(
  taskId: string,
  providerName: string,
  keyId: string,
  providerTaskId: string,
  model: ModelDef,
  waitSeconds: number
): Promise<GenerateResult> {
  const adapter = adapters[providerName];
  if (!adapter) {
    await updateTask(taskId, { status: "failed", error_message: `adapter ${providerName} not found` });
    return { taskId, status: "failed", progress: 0, urls: [], error: `adapter ${providerName} not found` };
  }

  const startedAt = Date.now();
  const deadline = startedAt + waitSeconds * 1000;
  let lastProgress = 10;

  // نجلب المفتاح الحالي للتحقق
  const pool = await getKeyPool(model.providers);
  const key = pool.find((k) => k.id === keyId);
  if (!key) {
    // المفتاح اختفى — جرّب أي مفتاح آخر متاح
    if (pool.length === 0) {
      return { taskId, status: "processing", progress: 0, urls: [] };
    }
  }
  const apiKey = key?.api_key ?? pool[0]?.api_key ?? "";

  while (Date.now() < deadline) {
    try {
      const r = await adapter.checkTask(apiKey, providerTaskId);
      if (r.status === "completed" && r.urls && r.urls.length > 0) {
        await updateTask(taskId, {
          status: "completed",
          progress: 100,
          result_urls_json: JSON.stringify(r.urls),
        });
        return { taskId, status: "completed", progress: 100, urls: r.urls };
      }
      if (r.status === "failed") {
        // هل هو خطأ مفتاح/رصيد؟ → أعد الإنشاء على المفتاح التالي
        const ec = classifyProviderError(0, r.error || "");
        if (shouldSwitchKey(ec)) {
          // حاول مفتاحًا آخر
          const switched = await trySwitchKey(taskId, model, providerTaskId);
          if (switched) return switched;
          // لا مفتاح بديل → تبقى processing
          return { taskId, status: "processing", progress: lastProgress, urls: [] };
        }
        // فشل حقيقي (params/policy)
        await updateTask(taskId, { status: "failed", error_message: r.error });
        return { taskId, status: "failed", progress: 0, urls: [], error: r.error };
      }
      // processing — حدّث التقدم
      const newProgress = r.progress ?? lastProgress + 5;
      lastProgress = Math.min(95, Math.max(lastProgress, newProgress));
      await updateTask(taskId, { status: "processing", progress: lastProgress });
    } catch (e) {
      // خطأ في checkTask — عادة مؤقت
      const pe = e instanceof ProviderError ? e : new ProviderError(0, (e as Error).message);
      const ec = classifyProviderError(pe.status, pe.message, pe.body);
      if (shouldSwitchKey(ec)) {
        const switched = await trySwitchKey(taskId, model, providerTaskId);
        if (switched) return switched;
      }
    }
    await sleep(3000);
  }

  // انتهت النافذة — أعد processing
  await updateTask(taskId, { status: "processing", progress: lastProgress });
  return { taskId, status: "processing", progress: lastProgress, urls: [] };
}

/** يحاول إنشاء المهمة على مفتاح آخر بعد فشل منتصف المهمة. */
async function trySwitchKey(
  taskId: string,
  model: ModelDef,
  failedProviderTaskId: string
): Promise<GenerateResult | null> {
  const pool = await getKeyPool(model.providers);
  // ابحث عن مفتاح غير الذي فشل
  const task = await getTask(taskId);
  const failedKeyId = task?.key_id;
  const candidates = pool.filter((k) => k.id !== failedKeyId);
  if (candidates.length === 0) return null;

  for (const key of candidates) {
    const adapter = adapters[key.provider];
    if (!adapter) continue;
    const providerModel = model.providerModel[key.provider as "kie" | "cometapi"];
    try {
      const args = task ? JSON.parse(task.params_json) : {};
      const r = await adapter.createTask(key.api_key, providerModel, task?.type === "image" ? "image" : "video", args);
      await bumpKeyCounters(key.id, { ok: true });
      await updateTask(taskId, {
        provider: key.provider,
        provider_task_id: r.providerTaskId,
        key_id: key.id,
        status: "processing",
        progress: 10,
        attempt: {
          provider: key.provider, keyId: key.id, keyLabel: key.label || key.provider,
          ok: true, errorClass: "switch", error: `switched from ${failedProviderTaskId}`,
          at: new Date().toISOString(),
        },
      });
      // تابع الانتظار على المفتاح الجديد
      return await waitForCompletion(taskId, key.provider, key.id, r.providerTaskId, model, 60);
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError(0, (e as Error).message);
      const ec = classifyProviderError(pe.status, pe.message, pe.body);
      await bumpKeyCounters(key.id, { ok: false, errorClass: ec, error: pe.message });
      if (!shouldSwitchKey(ec)) break;
    }
  }
  return null;
}

/** تحديث مهمة جارية عند استدعاء get_task — يحدّث من المزود ويعيد المحاولة إن لزم. */
export async function refreshTask(taskId: string): Promise<GenerateResult> {
  const task = await getTask(taskId);
  if (!task) {
    return { taskId, status: "failed", progress: 0, urls: [], error: "المهمة غير موجودة." };
  }
  if (task.status === "completed") {
    const urls = task.result_urls_json ? JSON.parse(task.result_urls_json) : [];
    return { taskId, status: "completed", progress: 100, urls };
  }
  if (task.status === "failed") {
    return { taskId, status: "failed", progress: 0, urls: [], error: task.error_message ?? "فشلت المهمة" };
  }

  // processing → حدّث من المزود
  if (!task.provider || !task.provider_task_id) {
    // لم يُنشأ بعد — أعد المحاولة مع تهدئة 45 ثانية
    const ageMs = Date.now() - new Date(task.updated_at).getTime();
    if (ageMs < 45000) {
      return { taskId, status: "processing", progress: task.progress, urls: [] };
    }
    // أعد المحاولة
    const model = resolveModel(task.model);
    if (!model) return { taskId, status: "processing", progress: task.progress, urls: [] };
    const switched = await trySwitchKey(taskId, model, task.provider_task_id ?? "");
    return switched ?? { taskId, status: "processing", progress: task.progress, urls: [] };
  }

  const adapter = adapters[task.provider];
  if (!adapter) return { taskId, status: "processing", progress: task.progress, urls: [] };

  const pool = await getKeyPool(modelProviders(task.model));
  const key = pool.find((k) => k.id === task.key_id) ?? pool[0];
  if (!key) return { taskId, status: "processing", progress: task.progress, urls: [] };

  try {
    const r = await adapter.checkTask(key.api_key, task.provider_task_id);
    if (r.status === "completed" && r.urls && r.urls.length > 0) {
      await updateTask(taskId, {
        status: "completed",
        progress: 100,
        result_urls_json: JSON.stringify(r.urls),
      });
      return { taskId, status: "completed", progress: 100, urls: r.urls };
    }
    if (r.status === "failed") {
      const ec = classifyProviderError(0, r.error || "");
      if (shouldSwitchKey(ec)) {
        const model = resolveModel(task.model);
        if (model) {
          const switched = await trySwitchKey(taskId, model, task.provider_task_id);
          if (switched) return switched;
        }
        // لا مفتاح بديل → تبقى processing
        await updateTask(taskId, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
        return { taskId, status: "processing", progress: task.progress, urls: [] };
      }
      await updateTask(taskId, { status: "failed", error_message: r.error });
      return { taskId, status: "failed", progress: 0, urls: [], error: r.error };
    }
    const newProgress = r.progress ?? task.progress;
    await updateTask(taskId, { status: "processing", progress: newProgress });
    return { taskId, status: "processing", progress: newProgress, urls: [] };
  } catch (e) {
    // خطأ مؤقت — تبقى processing
    return { taskId, status: "processing", progress: task.progress, urls: [] };
  }
}

/** يحل مزودي الموديل من اسمه الكنسي. */
function modelProviders(modelName: string): ("kie" | "cometapi")[] {
  const m = resolveModel(modelName);
  return m?.providers ?? ["kie", "cometapi"];
}

/** ينفّذ الدمج — يستدعي خدمة الدمج ويسجّل مهمة type=merge. */
export async function runMerge(args: {
  urls?: string[];
  taskIds?: string[];
  wait_seconds?: number;
}): Promise<GenerateResult> {
  const { urls: finalUrls, error } = await resolveMergeSources(args);
  if (error) {
    return { taskId: "", status: "failed", progress: 0, urls: [], error };
  }
  if (!finalUrls || finalUrls.length < 2) {
    return {
      taskId: "",
      status: "failed",
      progress: 0,
      urls: [],
      error: "الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
    };
  }
  if (finalUrls.length > 10) {
    return {
      taskId: "",
      status: "failed",
      progress: 0,
      urls: [],
      error: `أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى). تم تمرير ${finalUrls.length}.`,
    };
  }

  // سجّل مهمة الدمج
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: finalUrls.join(" + "),
    params_json: JSON.stringify({ urls: finalUrls, wait_seconds: args.wait_seconds }),
    status: "pending",
  });

  // أنشئ مهمة الدمج في الخدمة
  const { createMergeJob, processMergeJob, pollMergeJob } = await import("./merger");
  let jobId: string;
  try {
    const created = await createMergeJob(finalUrls);
    jobId = created.jobId;
    await updateTask(taskId, {
      provider_task_id: jobId,
      status: "processing",
      progress: 5,
    });
  } catch (e) {
    await updateTask(taskId, { status: "failed", error_message: (e as Error).message });
    return { taskId, status: "failed", progress: 0, urls: [], error: (e as Error).message };
  }

  // نفّذ الدمج
  const waitSeconds = Math.max(0, Math.min(240, args.wait_seconds ?? 60));
  const deadline = Date.now() + waitSeconds * 1000;

  // أطلق process خلفيًا
  processMergeJob(jobId).catch(() => {});

  while (Date.now() < deadline) {
    const r = await pollMergeJob(jobId);
    if (r.status === "done" && r.videoUrl) {
      const urls = [r.videoUrl];
      await updateTask(taskId, {
        status: "completed",
        progress: 100,
        result_urls_json: JSON.stringify(urls),
      });
      return { taskId, status: "completed", progress: 100, urls };
    }
    if (r.status === "failed") {
      await updateTask(taskId, { status: "failed", error_message: r.error });
      return { taskId, status: "failed", progress: 0, urls: [], error: r.error };
    }
    await updateTask(taskId, { status: "processing", progress: r.progress });
    await sleep(3000);
  }

  await updateTask(taskId, { status: "processing", progress: 50 });
  return { taskId, status: "processing", progress: 50, urls: [] };
}

/** يحل مصادر الدمج — يجمع task_ids ثم urls بالترتيب المعطى. */
async function resolveMergeSources(args: {
  urls?: string[];
  taskIds?: string[];
}): Promise<{ urls?: string[]; error?: string }> {
  const out: string[] = [];
  // task_ids أولاً
  if (args.taskIds && args.taskIds.length > 0) {
    for (const tid of args.taskIds) {
      const t = await getTask(tid);
      if (!t) {
        return { error: `مهمة غير موجودة: ${tid}` };
      }
      if (t.type !== "video" && t.type !== "merge") {
        return { error: `المهمة ${tid} ليست فيديو/دمج (type=${t.type}).` };
      }
      if (t.status !== "completed") {
        return { error: `المهمة ${tid} ليست مكتملة (status=${t.status}).` };
      }
      const urls = t.result_urls_json ? JSON.parse(t.result_urls_json) : [];
      if (urls.length === 0) {
        return { error: `المهمة ${tid} مكتملة لكن بلا روابط.` };
      }
      out.push(...urls);
    }
  }
  // ثم urls المباشرة
  if (args.urls) {
    for (const u of args.urls) {
      if (!/^https?:\/\//i.test(u)) {
        return { error: `رابط غير صالح (ليس http/https): ${u}` };
      }
      out.push(u);
    }
  }
  return { urls: out };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
