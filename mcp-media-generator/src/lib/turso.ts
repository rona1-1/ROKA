/**
 * src/lib/turso.ts — طبقة قاعدة بيانات Turso (libSQL عبر HTTP).
 *
 * مميزات هذه الطبقة:
 *  - عميل واحد عبر createClient (متوافق مع Vercel serverless).
 *  - ensureSchema: تنشئ الجداول عند أول وصول (CREATE TABLE IF NOT EXISTS) فلا حاجة لأداة migrations.
 *  - dbHealthy: فحص سريع SELECT 1.
 *  - عمليات المهام: insertTask, getTask, updateTask, listRecentTasks, taskStats.
 *  - عمليات المفاتيح: getKeyPool, insertKey, listKeys, patchKey, deleteKey, bumpKeyCounters.
 *
 * ملاحظة أمنية: لا تُطبع المفاتيح الكاملة في السجلات — استخدم maskKey من keypool.ts.
 */

import { createClient, type Client } from "@libsql/client";

let _client: Client | null = null;

/** عميل Turso وحيد (singleton) عبر HTTP — مناسب لبيئة Vercel serverless. */
export function db(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) {
      throw new Error(
        "متغيرات Turso غير مضبوطة: TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان."
      );
    }
    _client = createClient({ url, authToken });
  }
  return _client;
}

/** يُنشئ الجداول إن لم تكن موجودة (يدويًا عند أول وصول). */
export async function ensureSchema(): Promise<void> {
  const c = db();
  await c.batch([
    {
      sql: `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        provider TEXT,
        provider_task_id TEXT,
        key_id TEXT,
        model TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        params_json TEXT DEFAULT '{}',
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        result_urls_json TEXT,
        error_message TEXT,
        attempts_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      );`,
      args: [],
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT DEFAULT '',
        api_key TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        usage_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_checked_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );`,
      args: [],
    },
    // كل CREATE INDEX في عبارة منفصلة (libSQL لا يقبل عبارات متعددة في سلسلة واحدة)
    { sql: `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_keys_provider ON api_keys(provider);`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_keys_status ON api_keys(status);`, args: [] },
  ]);
}

/** فحص صحة الاتصال بقاعدة Turso. */
export async function dbHealthy(): Promise<boolean> {
  try {
    await db().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ===================== أنواع المهام =====================

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  params_json: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AttemptRecord {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

/** يُدرج مهمة جديدة ويعيدها. */
export async function insertTask(t: {
  id: string;
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  model: string;
  type: TaskRow["type"];
  prompt?: string;
  params_json?: string;
  status: TaskRow["status"];
  progress?: number;
}): Promise<void> {
  await db().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      t.id,
      t.provider ?? null,
      t.provider_task_id ?? null,
      t.key_id ?? null,
      t.model,
      t.type,
      t.prompt ?? "",
      t.params_json ?? "{}",
      t.status,
      t.progress ?? 0,
    ],
  });
}

/** يقرأ مهمة واحدة. */
export async function getTask(id: string): Promise<TaskRow | null> {
  const r = await db().execute({
    sql: `SELECT * FROM tasks WHERE id = ? LIMIT 1`,
    args: [id],
  });
  if (r.rows.length === 0) return null;
  return r.rows[0] as unknown as TaskRow;
}

/**
 * تحديث جزئي (patch) للمهمة:
 *  - يدعم تحديث أي مجموعة من الحقول.
 *  - يضيف محاولة جديدة إلى attempts_json إن وُفرت.
 *  - يضبط completed_at تلقائيًا عند الاكتمال (status=completed) أو الفشل (status=failed).
 *  - يحدّث updated_at دائمًا.
 */
export async function updateTask(
  id: string,
  patch: {
    provider?: string | null;
    provider_task_id?: string | null;
    key_id?: string | null;
    status?: TaskRow["status"];
    progress?: number;
    result_urls_json?: string | null;
    error_message?: string | null;
    attempt?: AttemptRecord;
  }
): Promise<void> {
  const cur = await getTask(id);
  if (!cur) return;

  const sets: string[] = ["updated_at = datetime('now')"];
  const args: (string | number | null)[] = [];

  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.provider_task_id !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.provider_task_id); }
  if (patch.key_id !== undefined) { sets.push("key_id = ?"); args.push(patch.key_id); }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
    if (patch.status === "completed" || patch.status === "failed") {
      sets.push("completed_at = datetime('now')");
      if (patch.status === "completed") sets.push("progress = 100");
    }
  }
  if (patch.progress !== undefined && patch.status !== "completed") {
    sets.push("progress = ?");
    args.push(patch.progress);
  }
  if (patch.result_urls_json !== undefined) { sets.push("result_urls_json = ?"); args.push(patch.result_urls_json); }
  if (patch.error_message !== undefined) { sets.push("error_message = ?"); args.push(patch.error_message); }

  // إضافة محاولة إلى attempts_json
  if (patch.attempt) {
    const attempts: AttemptRecord[] = cur.attempts_json
      ? JSON.parse(cur.attempts_json)
      : [];
    attempts.push(patch.attempt);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(attempts));
  }

  args.push(id);
  await db().execute({
    sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}

/** أحدث المهام مع فلترة اختيارية. */
export async function listRecentTasks(
  limit = 20,
  filter: { type?: string; status?: string } = {}
): Promise<TaskRow[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.type) { where.push("type = ?"); args.push(filter.type); }
  if (filter.status) { where.push("status = ?"); args.push(filter.status); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  args.push(limit);
  const r = await db().execute({
    sql: `SELECT * FROM tasks ${whereSql} ORDER BY created_at DESC LIMIT ?`,
    args,
  });
  return r.rows as unknown as TaskRow[];
}

/** إحصائيات سريعة للوحة. */
export async function taskStats(): Promise<{
  total: number;
  completed: number;
  failed: number;
  processing: number;
}> {
  const r = await db().execute({
    sql: `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS processing
      FROM tasks`,
    args: [],
  });
  const row = r.rows[0] as Record<string, number | null>;
  return {
    total: row.total ?? 0,
    completed: row.completed ?? 0,
    failed: row.failed ?? 0,
    processing: row.processing ?? 0,
  };
}
