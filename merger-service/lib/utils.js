/**
 * lib/utils.js — دوال مساعدة.
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const os = require("os");

/** مولّد معرّفات قصيرة عشوائية (مثل wkucdefoxwvd). */
function shortId(len = 12) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** حدود الخدمة من متغيرات البيئة. */
function limits() {
  return {
    maxSources: Number(process.env.MAX_SOURCES || 10),
    sourceMaxMb: Number(process.env.SOURCE_MAX_MB || 200),
    outputMaxMb: Number(process.env.OUTPUT_MAX_MB || 150),
    maxTotalDurationSec: Number(process.env.MAX_TOTAL_DURATION_SEC || 600),
    ffmpegPreset: process.env.FFMPEG_PRESET || "medium",
    chunkBytes: 4 * 1024 * 1024, // حد رفع الأجزاء للواجهة
    version: "1.0.0",
  };
}

/** ينشئ مجلد /tmp/merger-<job> للمعالجة. */
function jobTmpDir(jobId) {
  const dir = path.join(os.tmpdir(), `merger-${jobId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** يمسح مجلد /tmp بالكامل. */
function cleanupTmp(dir) {
  try {
    if (!dir) return;
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/** يحوّل Buffer إلى stream قابل للقراءة. */
function bufferToStream(buf) {
  const { Readable } = require("stream");
  return Readable.from(buf);
}

/** يتحقق من صحة رابط http/https. */
function isValidUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** يلخّص حجم البايتات بصيغة مقروءة. */
function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

module.exports = {
  shortId,
  limits,
  jobTmpDir,
  cleanupTmp,
  bufferToStream,
  isValidUrl,
  formatBytes,
};
