/**
 * src/lib/errors.ts — تصنيف موحد لأخطاء المزودين.
 *
 * جدول التصنيف (مطابق للمواصفة):
 *  disabled   : HTTP 401/403 أو رسالة مصادقة فاشلة → المفتاح مرفوض → تعطيل تلقائي + انتقال للتالي
 *  exhausted  : HTTP 402 أو رسالة نفاد رصيد (تُفحص قبل 400 لأن بعض المزودين يرسلونها بحالة 400)
 *  provider   : model not found/unsupported مع 400/404/422 → الموديل غير مدعوم لدى هذا المزود → انتقل للتالي
 *  params     : 400/422 معطيات الطلب → توقف فوري (تبديل المفاتيح لن يحل خطأ معطيات)
 *  temporary  : 429, 5xx, شبكة, timeout, abort → انتقل للتالي الآن (المفتاح يبقى سليمًا)
 */

export type ErrorClass =
  | "disabled"
  | "exhausted"
  | "provider"
  | "params"
  | "temporary"
  | "unknown";

/** خطأ مزود موحد — يُرمى من كل adapter ويُصنَّف هنا. */
export class ProviderError extends Error {
  status: number;
  body: string;
  errorClass: ErrorClass;

  constructor(status: number, message: string, body?: string) {
    super(message);
    this.status = status;
    this.body = body ?? "";
    this.errorClass = classifyProviderError(status, message, this.body);
    this.name = "ProviderError";
  }
}

/** أنماط رسائل نفاد الرصيد — تُفحص قبل 400 لأن بعض المزودين يرسلونها بحالة 400. */
const EXHAUSTED_PATTERNS = [
  "insufficient", "quota", "balance", "credit", "out of credits",
  "exhausted", "充值", "no credit", "rate limit balance", "payment required",
  "402",
];

const DISABLED_PATTERNS = [
  "invalid api key", "unauthorized", "forbidden", "authentication",
  "invalid_api_key", "apikey invalid", "key not found", "invalid token",
];

const PROVIDER_PATTERNS = [
  "model not found", "unsupported model", "model_unavailable",
  "no such model", "model unavailable", "unknown model",
];

const TEMPORARY_PATTERNS = [
  "rate limit", "too many requests", "timeout", "service unavailable",
  "internal server error", "bad gateway", "gateway timeout",
  "upstream error", "temporarily unavailable",
];

/** دالة التصنيف الموحدة (مطابقة لقسم 4.2 من المواصفة). */
export function classifyProviderError(
  status: number,
  message: string,
  body = ""
): ErrorClass {
  const text = `${message} ${body}`.toLowerCase();

  // 1) نفاد الرصيد أولاً (حتى لو جاء مع 400)
  if (EXHAUSTED_PATTERNS.some((p) => text.includes(p))) return "exhausted";

  // 2) مفتاح معطّل/مرفوض
  if (DISABLED_PATTERNS.some((p) => text.includes(p))) return "disabled";
  if (status === 401 || status === 403) return "disabled";

  // 3) موديل غير مدعوم
  if (PROVIDER_PATTERNS.some((p) => text.includes(p))) return "provider";

  // 4) نفاد الرصيد HTTP 402
  if (status === 402) return "exhausted";

  // 5) معطيات طلب تالفة → توقف فوري
  if (status === 400 || status === 422) return "params";

  // 6) أخطاء مؤقتة
  if (TEMPORARY_PATTERNS.some((p) => text.includes(p))) return "temporary";
  if (status === 429 || status >= 500) return "temporary";

  // 7) شبكة/timeout
  if (status === 0) return "temporary";

  return "unknown";
}

/** هل هذا التصنيف يستوجب التبديل لمفتاح آخر؟ (كلها ما عدا params) */
export function shouldSwitchKey(ec: ErrorClass): boolean {
  return ec !== "params";
}

/** هل هذا التصنيف يستوجب تعطيل المفتاح نهائيًا؟ (disabled فقط) */
export function shouldDisableKey(ec: ErrorClass): boolean {
  return ec === "disabled";
}

/** هل هذا التصنيف يستوجب تعليم المفتاح كـ exhausted؟ */
export function shouldMarkExhausted(ec: ErrorClass): boolean {
  return ec === "exhausted";
}
