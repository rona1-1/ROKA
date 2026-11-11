/**
 * api/jobs/[id]/index.js — GET (الحالة), DELETE (حذف).
 */

module.exports = async (req, res) => {
  const {
    ensureSchema, getJob, listSources, deleteJob, countChunks,
  } = require("../../../lib/db");
  await ensureSchema();

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "missing job id" });

  if (req.method === "GET") {
    const job = await getJob(id);
    if (!job) return res.status(404).json({ error: "المهمة غير موجودة" });
    const sources = await listSources(id);
    res.status(200).json({
      jobId: id,
      status: job.status,
      progress: job.progress,
      videoUrl: job.video_url,
      downloadUrl: job.download_url,
      size: job.size,
      duration: job.duration,
      resolution: job.resolution,
      error: job.error,
      expiresAt: job.expires_at,
      sourcesCount: sources.length,
    });
    return;
  }

  if (req.method === "DELETE") {
    const job = await getJob(id);
    if (!job) return res.status(404).json({ error: "المهمة غير موجودة" });
    await deleteJob(id);
    res.status(200).json({ ok: true, deleted: id });
    return;
  }

  res.status(405).json({ error: "الطريقة غير مدعومة" });
};
