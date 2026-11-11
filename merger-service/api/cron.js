/**
 * api/cron.js — GET: حذف المهام المنتهية (Cron يومي).
 * يستدعى مجدولًا من Vercel Crons (vercel.json).
 */

module.exports = async (req, res) => {
  const { ensureSchema, cleanupExpired } = require("../lib/db");
  await ensureSchema();
  const n = await cleanupExpired();
  res.status(200).json({ ok: true, deleted: n });
};
