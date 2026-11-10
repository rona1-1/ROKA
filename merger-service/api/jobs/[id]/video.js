/**
 * api/jobs/[id]/video.js — GET: بث الناتج بدعم Range (206).
 *
 * يحوّل صفوف الـ Blobs (output_chunks) إلى stream مع تقليم أول/آخر جزء حسب المدى المطلوب.
 * ?download=1 يجبر التحميل (Content-Disposition: attachment).
 */

const { Readable } = require("stream");

module.exports = async (req, res) => {
  const {
    ensureSchema, getJob, readChunksStream,
  } = require("../../../lib/db");
  await ensureSchema();

  const id = req.query.id;
  const job = await getJob(id);
  if (!job) return res.status(404).json({ error: "المهمة غير موجودة" });
  if (job.status !== "done") {
    return res.status(409).json({ error: `المهمة ليست مكتملة (status=${job.status})` });
  }

  const total = job.size || 0;
  const range = req.headers.range;

  // هيدرز أساسية
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=3600");
  if (req.query.download === "1" || req.query.download === "true") {
    res.setHeader("Content-Disposition", `attachment; filename="merged-${id}.mp4"`);
  } else {
    res.setHeader("Content-Disposition", `inline; filename="merged-${id}.mp4"`);
  }

  // مولّد async يقرأ الأجزاء ويبثها مع تقليم اختياري للنطاق
  async function* genChunks(start, end) {
    let pos = 0;
    for await (const chunk of readChunksStream("output_chunks", "job_id", id)) {
      const chunkStart = pos;
      const chunkEnd = pos + chunk.length - 1;
      pos += chunk.length;
      // تخطّ الأجزاء قبل النطاق
      if (chunkEnd < start) continue;
      // توقف بعد تجاوز النطاق
      if (chunkStart > end) break;
      // قص حسب النطاق
      const sliceStart = Math.max(0, start - chunkStart);
      const sliceEnd = Math.min(chunk.length - 1, end - chunkStart);
      yield chunk.slice(sliceStart, sliceEnd + 1);
    }
  }

  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (!m) return res.status(416).json({ error: "نطاق غير صالح" });
    const start = m[1] ? parseInt(m[1]) : 0;
    const end = m[2] ? parseInt(m[2]) : total - 1;
    if (start >= total || end >= total || start > end) {
      res.setHeader("Content-Range", `bytes */${total}`);
      return res.status(416).end();
    }
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length", end - start + 1);
    res.statusCode = 206;
    const stream = Readable.from(genChunks(start, end));
    stream.on("error", (e) => {
      console.error("video stream error:", e);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
    stream.pipe(res);
  } else {
    res.setHeader("Content-Length", total);
    res.statusCode = 200;
    const stream = Readable.from(genChunks(0, total - 1));
    stream.on("error", (e) => {
      console.error("video stream error:", e);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
    stream.pipe(res);
  }
};
