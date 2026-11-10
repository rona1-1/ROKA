/**
 * api/jobs/index.js — POST /api/jobs: إنشاء مهمة دمج.
 *
 * يقبل:
 *  {"videos":["url1","url2"]} — روابط مباشرة
 *  {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}
 *
 * يرجع 201: {jobId, status, statusUrl, processUrl, expiresAt} + uploads[] إن وُجدت ملفات.
 */

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "الطريقة غير مدعومة — استخدم POST" });
  }
  const {
    ensureSchema, insertJob, insertSource, cleanupExpired,
  } = require("../../lib/db");
  const { shortId, limits, isValidUrl } = require("../../lib/utils");

  await ensureSchema();
  await cleanupExpired();

  const lim = limits();
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: "JSON تالف" }); }

  // جمع المصادر من شكلين
  let sources = [];
  if (Array.isArray(body.videos)) {
    sources = body.videos.map((u, i) => ({ kind: "url", url: u, seq: i }));
  } else if (Array.isArray(body.sources)) {
    sources = body.sources.map((s, i) => ({ ...s, seq: i }));
  } else {
    return res.status(400).json({ error: "مرّر 'videos' (روابط) أو 'sources' (مصفوفة مصادر)" });
  }

  // تحقق العدد
  if (sources.length < 2) {
    return res.status(400).json({ error: "الدمج يحتاج مقطعَين على الأقل" });
  }
  if (sources.length > lim.maxSources) {
    return res.status(400).json({ error: `أقصى عدد مقاطع هو ${lim.maxSources}` });
  }

  // تحقق الروابط
  for (const s of sources) {
    if (s.kind === "url" && !isValidUrl(s.url)) {
      return res.status(400).json({ error: `رابط غير صالح: ${s.url}` });
    }
  }

  // إنشاء المهمة
  const jobId = shortId(12);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const hasFiles = sources.some((s) => s.kind === "file");

  await insertJob({
    id: jobId,
    sources: sources.map((s) => ({ kind: s.kind, url: s.url, name: s.name, size: s.size, mime: s.mime, seq: s.seq })),
    expiresAt,
  });

  // إدراج المصادر
  const uploads = [];
  for (const s of sources) {
    const srcId = shortId(10);
    await insertSource({
      id: srcId,
      jobId,
      kind: s.kind,
      url: s.url,
      name: s.name,
      size: s.size,
      mime: s.mime,
      seq: s.seq,
      expiresAt,
    });
    if (s.kind === "file") {
      uploads.push({
        sourceId: srcId,
        seq: s.seq,
        uploadUrl: `/api/upload?job=${jobId}&source=${srcId}&seq=${s.seq}`,
        chunkBytes: lim.chunkBytes,
      });
    }
  }

  res.status(201).json({
    jobId,
    status: hasFiles ? "uploading" : "queued",
    statusUrl: `/api/jobs/${jobId}`,
    processUrl: `/api/jobs/${jobId}/process`,
    expiresAt,
    uploads: uploads.length > 0 ? uploads : undefined,
    uploadChunkBytes: lim.chunkBytes,
  });
};
