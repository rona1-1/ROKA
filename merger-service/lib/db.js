/**
 * lib/db.js — طبقة Turso للخدمة (CommonJS).
 *
 * جداول: jobs, sources, source_chunks, output_chunks.
 * كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso) ويُقرأ تدفقيًا بصفحات 8 صفوف.
 * كل مهمة لها expires_at = created_at + 24 ساعة.
 */

const { createClient } = require("@libsql/client");

let _client;
function db() {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) {
      throw new Error("TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان");
    }
    _client = createClient({ url, authToken });
  }
  return _client;
}

const CHUNK_BYTES = 2 * 1024 * 1024; // 2MB حد HTTP في Turso

/** ينشئ الجداول عند أول وصول. */
async function ensureSchema() {
  const c = db();
  await c.batch([
    {
      sql: `CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'queued',
        progress INTEGER DEFAULT 0,
        sources_json TEXT DEFAULT '[]',
        video_url TEXT,
        download_url TEXT,
        size INTEGER,
        duration REAL,
        resolution TEXT,
        error TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );`,
      args: [],
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        url TEXT,
        name TEXT,
        size INTEGER,
        mime TEXT,
        seq INTEGER NOT NULL,
        duration REAL,
        width INTEGER,
        height INTEGER,
        fps REAL,
        has_audio INTEGER,
        downloaded_path TEXT,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );`,
      args: [],
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS source_chunks (
        source_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (source_id, seq),
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
      );`,
      args: [],
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS output_chunks (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (job_id, seq),
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );`,
      args: [],
    },
  ]);
}

/** فحص صحة الاتصال. */
async function dbHealthy() {
  try { await db().execute("SELECT 1"); return true; } catch { return false; }
}

// ===================== المهام =====================

async function insertJob(job) {
  await db().execute({
    sql: `INSERT INTO jobs (id, status, sources_json, expires_at) VALUES (?, 'queued', ?, ?)`,
    args: [job.id, JSON.stringify(job.sources || []), job.expiresAt],
  });
}

async function getJob(id) {
  const r = await db().execute({ sql: `SELECT * FROM jobs WHERE id = ? LIMIT 1`, args: [id] });
  return r.rows[0] || null;
}

async function updateJob(id, patch) {
  const cur = await getJob(id);
  if (!cur) return;
  const sets = ["updated_at = datetime('now')"];
  const args = [];
  for (const k of ["status", "progress", "video_url", "download_url", "size", "duration", "resolution", "error"]) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = ?`);
      args.push(patch[k]);
    }
  }
  args.push(id);
  await db().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

// ===================== المصادر =====================

async function insertSource(src) {
  await db().execute({
    sql: `INSERT INTO sources (id, job_id, kind, url, name, size, mime, seq, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [src.id, src.jobId, src.kind, src.url || null, src.name || null, src.size || null, src.mime || null, src.seq, src.expiresAt],
  });
}

async function listSources(jobId) {
  const r = await db().execute({ sql: `SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC`, args: [jobId] });
  return r.rows;
}

// ===================== أجزاء الـ Blobs =====================

/** يخزّن Buffer كأجزاء 2MB. */
async function storeChunks(table, keyField, keyValue, buffer) {
  const c = db();
  const chunks = [];
  for (let i = 0; i < buffer.length; i += CHUNK_BYTES) {
    chunks.push(Buffer.from(buffer.slice(i, i + CHUNK_BYTES)));
  }
  // حذف الأجزاء القديمة أولًا
  await c.execute({ sql: `DELETE FROM ${table} WHERE ${keyField} = ?`, args: [keyValue] });
  // إدراج الأجزاء الجديدة على دفعات
  for (let i = 0; i < chunks.length; i++) {
    await c.execute({
      sql: `INSERT INTO ${table} (${keyField}, seq, data) VALUES (?, ?, ?)`,
      args: [keyValue, i, chunks[i]],
    });
  }
  return chunks.length;
}

/** يقرأ الأجزاء كـ Readable stream. */
async function* readChunksStream(table, keyField, keyValue) {
  const c = db();
  // عدد الأجزاء
  const countR = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM ${table} WHERE ${keyField} = ?`,
    args: [keyValue],
  });
  const n = countR.rows[0].n;
  // قراءة بصفحات 8 صفوف
  const PAGE = 8;
  for (let i = 0; i < n; i += PAGE) {
    const r = await c.execute({
      sql: `SELECT seq, data FROM ${table} WHERE ${keyField} = ? ORDER BY seq ASC LIMIT ? OFFSET ?`,
      args: [keyValue, PAGE, i],
    });
    for (const row of r.rows) {
      yield Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
    }
  }
}

/** يجمع الأجزاء إلى Buffer واحد (للاستخدام في ffmpeg). */
async function readChunksBuffer(table, keyField, keyValue) {
  const chunks = [];
  for await (const chunk of readChunksStream(table, keyField, keyValue)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** عدد الأجزاء. */
async function countChunks(table, keyField, keyValue) {
  const r = await db().execute({
    sql: `SELECT COUNT(*) AS n FROM ${table} WHERE ${keyField} = ?`,
    args: [keyValue],
  });
  return r.rows[0].n;
}

// ===================== الحذف =====================

/** حذف شامل لمهمة (jobs + sources + source_chunks + output_chunks). */
async function deleteJob(id) {
  const c = db();
  // حذف أجزاء المصادر أولًا (foreign key cascade قد لا يعمل عبر HTTP)
  const sources = await listSources(id);
  for (const s of sources) {
    await c.execute({ sql: `DELETE FROM source_chunks WHERE source_id = ?`, args: [s.id] });
  }
  await c.execute({ sql: `DELETE FROM sources WHERE job_id = ?`, args: [id] });
  await c.execute({ sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [id] });
  await c.execute({ sql: `DELETE FROM jobs WHERE id = ?`, args: [id] });
}

/** حذف أجزاء المصادر بعد نجاح الدمج (الناتج فقط هو المطلوب). */
async function deleteSourceChunks(jobId) {
  const c = db();
  const sources = await listSources(jobId);
  for (const s of sources) {
    await c.execute({ sql: `DELETE FROM source_chunks WHERE source_id = ?`, args: [s.id] });
  }
}

/** تنظيف كسول للمهام المنتهية. */
async function cleanupExpired() {
  const c = db();
  const r = await c.execute({
    sql: `SELECT id FROM jobs WHERE expires_at < datetime('now')`,
    args: [],
  });
  for (const row of r.rows) {
    await deleteJob(row.id);
  }
  return r.rows.length;
}

module.exports = {
  CHUNK_BYTES,
  db,
  ensureSchema,
  dbHealthy,
  insertJob,
  getJob,
  updateJob,
  insertSource,
  listSources,
  storeChunks,
  readChunksStream,
  readChunksBuffer,
  countChunks,
  deleteJob,
  deleteSourceChunks,
  cleanupExpired,
};
