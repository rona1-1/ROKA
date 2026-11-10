/**
 * api/upload.js — POST: رفع أجزاء الملفات (ثنائي ≤4MB).
 * ?job=<id>&source=<id>&seq=<n>&chunk=<k>
 *
 * إعادة محاولة تلقائية في الواجهة ×3 عند الفشل.
 */

module.exports = async (req, res) => {
  const {
    ensureSchema, getJob, storeChunks, readChunksBuffer,
  } = require("../lib/db");
  const { limits } = require("../lib/utils");

  await ensureSchema();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "استخدم POST" });
  }
  const jobId = req.query.job;
  const sourceId = req.query.source;
  if (!jobId || !sourceId) {
    return res.status(400).json({ error: "job و source مطلوبان في query" });
  }
  const job = await getJob(jobId);
  if (!job) return res.status(404).json({ error: "المهمة غير موجودة" });

  // الجسم: ثنائي raw
  let buf;
  if (Buffer.isBuffer(req.body)) buf = req.body;
  else if (typeof req.body === "string") buf = Buffer.from(req.body);
  else buf = Buffer.from(req.body || "");

  const lim = limits();
  if (buf.length > lim.chunkBytes) {
    return res.status(413).json({ error: `الجزء يتجاوز ${lim.chunkBytes} بايت` });
  }

  // خزّن الجزء — نستخدم نظام الأجزاء في Turso مباشرة
  // نقرأ الأجزاء الموجودة + نضيف الجديد + نعيد التخزين
  // (للتبسيط: نخزّن كل رفع كـ source_chunks كاملة باستخدام storeChunks)
  try {
    // اقرأ الموجود إن وُجد
    let existing = Buffer.alloc(0);
    try {
      existing = await readChunksBuffer("source_chunks", "source_id", sourceId);
    } catch {}
    const combined = Buffer.concat([existing, buf]);
    await storeChunks("source_chunks", "source_id", sourceId, combined);
    res.status(200).json({ ok: true, received: buf.length, total: combined.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
