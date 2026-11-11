/**
 * src/lib/merger.ts — عميل خدمة دمج الفيديو (Video Merger API v2).
 *
 * القواعد الجوهرية:
 *  - بلا مفاتيح أو توثيق — عنوان من MERGER_API_BASE.
 *  - مخرجات MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18. لا معاملات resolution/fps.
 *  - قيود: 10 مقاطع كحد أقصى، 200MB لكل رابط، 150MB للناتج، 600 ثانية مجموع مدد.
 *  - كل الملفات تُحذف تلقائيًا بعد 24 ساعة.
 *  - أخطاء خدمة الدمج المعلنة (4xx/5xx بجسم error) = فشل حتمي فوري.
 *  - أخطاء شبكتنا (timeout/fetch) = مؤقتة → استمر بالاستعلام.
 */

const MERGER_BASE = () =>
  process.env.MERGER_API_BASE || "http://localhost:3001";

export interface MergeJobResult {
  jobId: string;
  status: "queued" | "processing" | "done" | "failed";
  progress: number;
  videoUrl?: string;
  downloadUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  error?: string;
  expiresAt?: string;
}

/** إنشاء مهمة دمج — يُرجع jobId وحالات الروابط. */
export async function createMergeJob(urls: string[]): Promise<{
  jobId: string;
  statusUrl: string;
  processUrl: string;
  expiresAt?: string;
}> {
  const resp = await fetch(`${MERGER_BASE()}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: urls }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    // خطأ HTTP معلن من خدمة الدمج = فشل حتمي
    throw new MergeError(
      resp.status,
      `فشل إنشاء مهمة الدمج: HTTP ${resp.status}`,
      text
    );
  }
  const data = JSON.parse(text);
  return {
    jobId: data.jobId,
    statusUrl: data.statusUrl,
    processUrl: data.processUrl,
    expiresAt: data.expiresAt,
  };
}

/**
 * تنفيذ الدمج — POST /api/jobs/{id}/process.
 * ملاحظة: هذا الطلب متزامن (blocking ~10-15 ثانية). نطلقه خلفيًا بمرة واحدة فقط
 * ونحميه بقفل في الذاكرة (processInFlight) لمنع تزامن استدعائه مع get_task.
 */
const processInFlight = new Set<string>();

export async function processMergeJob(jobId: string): Promise<MergeJobResult> {
  if (processInFlight.has(jobId)) {
    // طلب process جارٍ بالفعل — لا تكرره
    return pollMergeJob(jobId);
  }
  processInFlight.add(jobId);
  try {
    const resp = await fetch(`${MERGER_BASE()}/api/jobs/${jobId}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const text = await resp.text();
    // 202 يعني قيد المعالجة فعلًا — نُرجع الحالة الحالية
    if (resp.status === 202) {
      return await pollMergeJob(jobId);
    }
    if (!resp.ok) {
      throw new MergeError(
        resp.status,
        `فشل تنفيذ الدمج: HTTP ${resp.status}`,
        text
      );
    }
    const data = JSON.parse(text);
    return normalizeMergeResult(jobId, data);
  } catch (e) {
    // خطأ شبكة = مؤقت — نُرجع الحالة الحالية بدل رمي
    if (e instanceof MergeError) throw e;
    return await pollMergeJob(jobId);
  } finally {
    // أزل من القفل بعد فترة قصيرة لإتاحة إعادة المحاولة إن لزم
    setTimeout(() => processInFlight.delete(jobId), 5000);
  }
}

/** استعلام حالة مهمة دمج — GET /api/jobs/{id}. */
export async function pollMergeJob(jobId: string): Promise<MergeJobResult> {
  let resp: Response;
  try {
    resp = await fetch(`${MERGER_BASE()}/api/jobs/${jobId}`, {
      method: "GET",
    });
  } catch (e) {
    // خطأ شبكة = مؤقت → نُرجع حالة processing بدل رمي
    return {
      jobId,
      status: "processing",
      progress: 10,
      error: `مؤقت: ${(e as Error).message}`,
    };
  }

  // 404 = فشل نهائي: مهمة الدمج غير موجودة/منتهية الصلاحية
  if (resp.status === 404) {
    return {
      jobId,
      status: "failed",
      progress: 0,
      error:
        "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة).",
    };
  }

  const text = await resp.text();
  if (!resp.ok) {
    throw new MergeError(resp.status, `HTTP ${resp.status}`, text);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new MergeError(resp.status, "response not JSON", text);
  }
  return normalizeMergeResult(jobId, data);
}

/** يوحّد شكل النتيجة من استجابات الخدمة المختلفة. */
function normalizeMergeResult(jobId: string, data: any): MergeJobResult {
  // قد يرد الجسم فيه error بدون status → عاملها failed فورًا
  if (data.error && !data.status) {
    return {
      jobId,
      status: "failed",
      progress: 0,
      error: String(data.error),
    };
  }
  const statusRaw = String(data.status ?? "").toLowerCase();
  const isDone = ["done", "completed", "complete", "success", "succeeded", "finished"].includes(statusRaw);
  const isFailed = ["error", "failed", "failure", "cancelled"].includes(statusRaw);

  let progress = typeof data.progress === "number"
    ? (data.progress <= 1 ? data.progress * 100 : data.progress)
    : isDone ? 100 : isFailed ? 0 : 10;

  // رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا وبقي jobId فاضبط المسار
  const videoUrl = data.videoUrl || data.video_url ||
    (isDone ? `${MERGER_BASE()}/api/jobs/${jobId}/video` : undefined);
  const downloadUrl = data.downloadUrl || data.download_url ||
    (isDone ? `${MERGER_BASE()}/api/jobs/${jobId}/video?download=1` : undefined);

  return {
    jobId,
    status: isDone ? "done" : isFailed ? "failed" : "processing",
    progress,
    videoUrl,
    downloadUrl,
    size: data.size,
    duration: data.duration,
    resolution: data.resolution,
    error: isFailed ? String(data.error || "فشل الدمج") : undefined,
    expiresAt: data.expiresAt,
  };
}

/** فحص جهوزية خدمة الدمج — GET /api/config بمهلة 4 ثوانٍ. */
export async function mergerHealthy(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const resp = await fetch(`${MERGER_BASE()}/api/config`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return resp.ok;
  } catch {
    return false;
  }
}

/** خطأ خدمة دمج — يميّز بين HTTP معلن (حتمي) وشبكة (مؤقت). */
export class MergeError extends Error {
  status: number;
  body: string;
  constructor(status: number, message: string, body?: string) {
    super(message);
    this.status = status;
    this.body = body ?? "";
    this.name = "MergeError";
  }
}

/** تنظيف اختياري — DELETE /api/jobs/{id}. */
export async function deleteMergeJob(jobId: string): Promise<void> {
  try {
    await fetch(`${MERGER_BASE()}/api/jobs/${jobId}`, { method: "DELETE" });
  } catch {
    // تجاهل — تنظيف اختياري
  }
}
