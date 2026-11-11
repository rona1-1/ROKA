/**
 * api/config.js — GET: الحدود العامة + version + فحص الجهوزية.
 */

module.exports = async (req, res) => {
  const { ensureSchema, dbHealthy } = require("../lib/db");
  const { limits } = require("../lib/utils");
  await ensureSchema();
  const lim = limits();
  const healthy = await dbHealthy();
  res.status(200).json({
    ok: true,
    healthy,
    version: lim.version,
    limits: {
      maxSources: lim.maxSources,
      sourceMaxMb: lim.sourceMaxMb,
      outputMaxMb: lim.outputMaxMb,
      maxTotalDurationSec: lim.maxTotalDurationSec,
      uploadChunkBytes: lim.chunkBytes,
    },
    ffmpegPreset: lim.ffmpegPreset,
    expiresAfterHours: 24,
  });
};
