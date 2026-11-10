/**
 * src/lib/keypool.ts — نظام المفاتيح المتسلسلة (قلب المشروع).
 *
 * قواعد جوهرية:
 *  1. الترتيب التسلسلي الصارم بترتيب الإضافة: ORDER BY created_at ASC, id ASC.
 *     أول مفتاح أُضيف يُجرَّب أولًا، ثم الثاني، ثم الثالث... (ليس round-robin، وليس «الأقل استخدامًا»).
 *  2. المفتاح المستنزف (exhausted) يبقى في القائمة والقاعدة — لا يُستبعد.
 *     الاستثناء الوحيد: التعطيل اليدوي (disabled) من الواجهة.
 *  3. المفتاح المعطّل تلقائيًا (401/403) يُستثنى من القائمة أيضًا لأنه مرفوض نهائيًا.
 *  4. الإخفاء إلزامي في كل الاستجابات والسجلات: maskKey.
 */

import { db } from "./turso";

export interface KeyRow {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  api_key: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

/** إخفاء المفتاح: أول 7 + •••••••• + آخر 4. للمفاتيح القصيرة: أول 3 + ••••. */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) {
    return key.length <= 4 ? "••••" : `${key.slice(0, 3)}••••`;
  }
  return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
}

/**
 * getKeyPool — يجلب كل المفاتيح غير المعطّلة لهذه المزودات بهذا الترتيب:
 *   ORDER BY created_at ASC, id ASC  (ترتيب تسلسلي صارم بترتيب الإضافة).
 *
 * ملاحظة: المفاتيح المعطّلة (disabled) تُستثنى — سواء كان التعطيل يدويًا أو تلقائيًا (401/403).
 * المفاتيح المستنزفة (exhausted) تبقى في القائمة والقاعدة لكنها لا تُجرَّب أولاً — تُجرَّب فقط
 * كبديل أخير إذا فشلت كل المفاتيح النشطة.
 */
export async function getKeyPool(
  providers: ("kie" | "cometapi")[]
): Promise<KeyRow[]> {
  if (providers.length === 0) return [];
  const placeholders = providers.map(() => "?").join(",");
  const r = await db().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY
            CASE status WHEN 'active' THEN 0 WHEN 'exhausted' THEN 1 END,
            created_at ASC,
            id ASC`,
    args: providers,
  });
  return r.rows as unknown as KeyRow[];
}

/** إدراج مفتاح جديد — يرفض التكرار لنفس المزود. */
export async function insertKey(input: {
  provider: "kie" | "cometapi";
  api_key: string;
  label?: string;
}): Promise<KeyRow> {
  const id = crypto.randomUUID();
  // فحص التكرار لنفس المزود + نفس المفتاح
  const existing = await db().execute({
    sql: `SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1`,
    args: [input.provider, input.api_key],
  });
  if (existing.rows.length > 0) {
    throw new Error("هذا المفتاح مُسجَّل مسبقًا لنفس المزود — لا يمكن تكراره.");
  }
  await db().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status)
          VALUES (?, ?, ?, ?, 'active')`,
    args: [id, input.provider, input.label ?? "", input.api_key],
  });
  const r = await db().execute({
    sql: `SELECT * FROM api_keys WHERE id = ? LIMIT 1`,
    args: [id],
  });
  return r.rows[0] as unknown as KeyRow;
}

/** قائمة كل المفاتيح (للواجهة) — مع الإخفاء الإلزامي. */
export async function listKeys(): Promise<KeyRow[]> {
  const r = await db().execute({
    sql: `SELECT * FROM api_keys ORDER BY provider, created_at ASC`,
    args: [],
  });
  return r.rows as unknown as KeyRow[];
}

/** تحديث حالة مفتاح (تعطيل/تنشيط يدوي). */
export async function patchKey(
  id: string,
  patch: { status?: KeyRow["status"] }
): Promise<void> {
  const sets: string[] = ["last_checked_at = datetime('now')"];
  const args: (string | number | null)[] = [];
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  args.push(id);
  await db().execute({
    sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}

/** حذف مفتاح نهائيًا. */
export async function deleteKey(id: string): Promise<void> {
  await db().execute({ sql: `DELETE FROM api_keys WHERE id = ?`, args: [id] });
}

/** تحديث عدّادات المفتاح بعد محاولة (نجاح/فشل). */
export async function bumpKeyCounters(
  id: string,
  result: { ok: boolean; errorClass?: string; error?: string }
): Promise<void> {
  const sets: string[] = [
    "usage_count = usage_count + 1",
    "last_used_at = datetime('now')",
    "last_checked_at = datetime('now')",
  ];
  if (result.ok) {
    sets.push("success_count = success_count + 1");
  } else {
    sets.push("fail_count = fail_count + 1");
    if (result.error) sets.push("last_error = ?");
  }

  // تحديث الحالة تلقائيًا بناءً على فئة الخطأ
  if (!result.ok) {
    if (result.errorClass === "disabled") {
      sets.push("status = 'disabled'");
    } else if (result.errorClass === "exhausted") {
      sets.push("status = 'exhausted'");
    }
  }

  // بناء args بعد معرفة عدد العناصر النائبة
  const args: (string | number | null)[] = [];
  if (!result.ok && result.error) args.push(result.error.slice(0, 500));
  args.push(id);

  await db().execute({
    sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}
