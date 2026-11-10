/**
 * api/jobs/[id]/process.js — POST: تنفيذ الدمج كاملًا (متزامن blocking).
 *
 * ينزّل/يسحب المصادر ← يرمّز ← يحفظ الناتج في Turso (output_chunks) ← يرجع الرابط.
 * لو المهمة قيد المعالجة فعله يرجع 202.
 */

const fs = require("fs");
const path = require("path");

module.exports = async (req, res) => {
  const {
    ensureSchema, getJob, listSources, updateJob,
    storeChunks, deleteSourceChunks, cleanupExpired,
  } = require("../../../lib/db");
  const { probe, mergeVideos, ensureExecutable } = require("../../../lib/merge");
  const { jobTmpDir, cleanupTmp, limits } = require("../../../lib/utils");

  await ensureSchema();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "استخدم POST" });
  }

  const id = req.query.id;
  const job = await getJob(id);
  if (!job) return res.status(404).json({ error: "المهمة غير موجودة" });

  // لو قيد المعالجة فعله → 202
  if (job.status === "processing") {
    return res.status(202).json({
      status: "processing",
      progress: job.progress,
      statusUrl: `/api/jobs/${id}`,
    });
  }
  // لو مكتملة → أعد النتيجة
  if (job.status === "done") {
    return res.status(200).json({
      status: "done",
      videoUrl: job.video_url,
      downloadUrl: job.download_url,
      size: job.size,
      duration: job.duration,
      resolution: job.resolution,
      expiresAt: job.expires_at,
    });
  }
  if (job.status === "failed") {
    return res.status(409).json({ error: job.error || "المهمة فاشلة سابقًا" });
  }

  // queued/uploading → ابدأ المعالجة
  const sources = await listSources(id);
  const lim = limits();
  const tmpDir = jobTmpDir(id);
  const localPaths = [];

  try {
    await updateJob(id, { status: "processing", progress: 5 });

    // 1. سحب كل مصدر إلى /tmp
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const outPath = path.join(tmpDir, `src-${i}.${(s.mime || "mp4").includes("quicktime") ? "mov" : "mp4"}`);
      if (s.kind === "url") {
        await downloadToFile(s.url, outPath, lim.sourceMaxMb);
      } else {
        // ملف مرفوع — اجمع أجزاءه من Turso
        const { readChunksBuffer } = require("../../../lib/db");
        const buf = await readChunksBuffer("source_chunks", "source_id", s.id);
        fs.writeFileSync(outPath, buf);
      }
      // تحقق حجم الملف
      const stat = fs.statSync(outPath);
      if (stat.size > lim.sourceMaxMb * 1024 * 1024) {
        throw new Error(`المصدر ${i + 1} حجمه ${(stat.size / 1048576).toFixed(1)}MB تجاوز الحد ${lim.sourceMaxMb}MB`);
      }
      localPaths.push(outPath);
      await updateJob(id, { progress: 10 + Math.round((i / sources.length) * 30) });
    }

    // 2. دمج بـ ffmpeg
    const result = await mergeVideos(localPaths, {
      onProgress: (p) => updateJob(id, { progress: p }).catch(() => {}),
    });

    // 3. خزّن الناتج في Turso (output_chunks)
    // البروتوكول من ترويسة x-forwarded-proto (Vercel) أو من MERGER_PUBLIC_BASE
    const proto = req.headers["x-forwarded-proto"] || (req.socket?.encrypted ? "https" : "http");
    const base = process.env.MERGER_PUBLIC_BASE || `${proto}://${req.headers.host || "localhost"}`;
    const videoUrl = `${base}/api/jobs/${id}/video`;
    const downloadUrl = `${base}/api/jobs/${id}/video?download=1`;

    await storeChunks("output_chunks", "job_id", id, result.buffer);
    await updateJob(id, {
      status: "done",
      progress: 100,
      video_url: videoUrl,
      download_url: downloadUrl,
      size: result.size,
      duration: result.duration,
      resolution: result.resolution,
    });

    // احذف أجزاء المصادر بعد نجاح الدمج (الناتج فقط هو المطلوب)
    await deleteSourceChunks(id);

    res.status(200).json({
      status: "done",
      videoUrl,
      downloadUrl,
      size: result.size,
      duration: result.duration,
      resolution: result.resolution,
      expiresAt: job.expires_at,
    });
  } catch (e) {
    await updateJob(id, { status: "failed", error: e.message });
    res.status(500).json({ error: e.message });
  } finally {
    cleanupTmp(tmpDir);
    cleanupExpired().catch(() => {});
  }
};

/** ينزّل رابطًا إلى ملف مع تحقق الحجم. */
async function downloadToFile(url, outPath, maxMb) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`فشل تحميل الرابط: HTTP ${resp.status}`);
  const contentLength = parseInt(resp.headers.get("content-length") || "0");
  if (contentLength && contentLength > maxMb * 1024 * 1024) {
    throw new Error(`حجم المصدر ${(contentLength / 1048576).toFixed(1)}MB تجاوز الحد ${maxMb}MB`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > maxMb * 1024 * 1024) {
    throw new Error(`حجم المصدر ${(buf.length / 1048576).toFixed(1)}MB تجاوز الحد ${maxMb}MB`);
  }
  fs.writeFileSync(outPath, buf);
}
