/**
 * lib/merge.js — محرك دمج الفيديو بـ ffmpeg.
 *
 * التدفق:
 *  1. ffprobe لكل مصدر: الدقة، fps، المدة، وجود صوت.
 *  2. توحيد كل المصادر عبر filter_complex: scale + pad إلى أكبر دقة (≤1920×1080، أبعاد زوجية)،
 *     fps=30، setsar=1، format=yuv420p، ثم concat=n=:v=1:a=1.
 *  3. مصدر بلا صوت → أضف مسارًا صامتًا anullsrc بنفس مدته.
 *  4. الترميز النهائي: libx264 CRF 18 + AAC 192k/44100Hz + +faststart.
 *  5. تقدم الترميز: اقرأ out_time_us من -progress pipe:1 واحسب النسبة من المدة الإجمالية.
 *
 * ضمان الأبعاد الزوجية + الحد الأقصى 1920×1080.
 */

const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const fs = require("fs");
const path = require("path");
const { limits, jobTmpDir, cleanupTmp } = require("./utils");

/** يضمن صلاحية التنفيذ لثنائي ffmpeg (قد يفقدها في الاستضافة). */
function ensureExecutable(binPath) {
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return binPath;
  } catch {
    // انسخه إلى /tmp بصلاحية 755
    const tmpBin = path.join(require("os").tmpdir(), "ffmpeg-bin");
    fs.copyFileSync(binPath, tmpBin);
    fs.chmodSync(tmpBin, 0o755);
    return tmpBin;
  }
}

/** يفحص مصدرًا بـ ffprobe. */
function probe(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,r_frame_rate,duration",
      "-show_entries", "format=duration",
      "-of", "json",
      filePath,
    ];
    const p = spawn(ffprobePath, args);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${stderr}`));
      try {
        const j = JSON.parse(stdout);
        const stream = j.streams?.[0] || {};
        const duration = parseFloat(stream.duration || j.format?.duration || 0);
        // فحص وجود صوت
        const audioArgs = ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", filePath];
        const ap = spawn(ffprobePath, audioArgs);
        let aOut = "";
        ap.stdout.on("data", (d) => (aOut += d));
        ap.on("close", () => {
          const fps = parseFps(stream.r_frame_rate);
          resolve({
            width: parseInt(stream.width) || 0,
            height: parseInt(stream.height) || 0,
            fps,
            duration,
            hasAudio: aOut.trim() === "audio",
          });
        });
        ap.on("error", () => resolve({
          width: parseInt(stream.width) || 0,
          height: parseInt(stream.height) || 0,
          fps: parseFps(stream.r_frame_rate),
          duration,
          hasAudio: false,
        }));
      } catch (e) { reject(e); }
    });
  });
}

function parseFps(rate) {
  if (!rate) return 30;
  const [n, d] = rate.split("/");
  return d ? parseInt(n) / parseInt(d) : parseInt(n);
}

/** يبني filter_complex لدمج N مصدر. */
function buildFilter(sources) {
  // أكبر دقة بين المدخلات (حد أقصى 1920×1080، أبعاد زوجية)
  let maxW = 0, maxH = 0;
  for (const s of sources) {
    if (s.width > maxW) maxW = s.width;
    if (s.height > maxH) maxH = s.height;
  }
  // الحد الأقصى 1920×1080 + أبعاد زوجية
  if (maxW > 1920) maxW = 1920;
  if (maxH > 1080) maxH = 1080;
  if (maxW % 2) maxW--;
  if (maxH % 2) maxH--;
  if (maxW < 2) maxW = 2;
  if (maxH < 2) maxH = 2;

  const parts = [];
  const labels = [];
  sources.forEach((s, i) => {
    parts.push(
      `[${i}:v]scale=${maxW}:${maxH}:force_original_aspect_ratio=decrease,pad=${maxW}:${maxH}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`
    );
    if (s.hasAudio) {
      parts.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      labels.push(`[v${i}][a${i}]`);
    } else {
      // مسار صامت بنفس مدة المصدر
      parts.push(`anullsrc=channel_layout=stereo:sample_rate=44100:duration=${s.duration || 5}[a${i}]`);
      labels.push(`[v${i}][a${i}]`);
    }
  });
  parts.push(`${labels.join("")}concat=n=${sources.length}:v=1:a=1[outv][outa]`);
  return {
    filter: parts.join(";"),
    targetWidth: maxW,
    targetHeight: maxH,
  };
}

/** ينفّذ الدمج ويُعيد Buffer الناتج + بياناته. */
async function mergeVideos(
  sourcePaths,
  { onProgress } = {}
) {
  const lim = limits();
  const bin = ensureExecutable(ffmpegPath);
  const os = require("os");
  const path = require("path");
  const fs = require("fs");

  // 1. فحص كل مصدر
  const probed = [];
  for (const p of sourcePaths) {
    const info = await probe(p);
    probed.push({ path: p, ...info });
  }

  // التحقق من الحدود
  const totalDuration = probed.reduce((a, b) => a + b.duration, 0);
  if (totalDuration > lim.maxTotalDurationSec) {
    throw new Error(`المدة الإجمالية ${totalDuration.toFixed(1)}ث تجاوزت الحد ${lim.maxTotalDurationSec}ث`);
  }

  // 2. بناء filter_complex
  const { filter, targetWidth, targetHeight } = buildFilter(probed);

  // 3. ملف إخراج مؤقت (MP4 +faststart يحتاج seekable output — لا يمكن لـ stdout)
  const outFile = path.join(os.tmpdir(), `merge-out-${Date.now()}.mp4`);

  // 4. تشغيل ffmpeg
  const args = ["-y"];
  for (const s of probed) args.push("-i", s.path);
  args.push(
    "-filter_complex", filter,
    "-map", "[outv]",
    "-map", "[outa]",
    "-c:v", "libx264",
    "-preset", lim.ffmpegPreset,
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "44100",
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    "-nostdin",
    "-f", "mp4",
    outFile
  );

  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let stderr = "";
    p.stdout.on("data", (d) => {
      const text = d.toString();
      // اقرأ out_time_us وحسب النسبة
      const m = text.match(/out_time_us=(\d+)/);
      if (m && onProgress) {
        const curUs = parseInt(m[1]);
        const pct = Math.min(90, Math.max(40, 40 + (curUs / 1000000 / totalDuration) * 50));
        onProgress(Math.round(pct));
      }
    });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", (e) => reject(new Error(`ffmpeg spawn error: ${e.message}`)));
    p.on("close", (code) => {
      if (code !== 0) {
        try { fs.unlinkSync(outFile); } catch {}
        return reject(new Error(`ffmpeg failed (code ${code}): ${stderr.slice(-2000)}`));
      }
      try {
        const buffer = fs.readFileSync(outFile);
        try { fs.unlinkSync(outFile); } catch {}
        const sizeMb = buffer.length / (1024 * 1024);
        if (sizeMb > lim.outputMaxMb) {
          return reject(new Error(`حجم الناتج ${sizeMb.toFixed(1)}MB تجاوز الحد ${lim.outputMaxMb}MB`));
        }
        onProgress && onProgress(100);
        resolve({
          buffer,
          size: buffer.length,
          duration: totalDuration,
          resolution: `${targetWidth}x${targetHeight}`,
        });
      } catch (e) {
        reject(new Error(`فشل قراءة الناتج: ${e.message}`));
      }
    });
  });
}

module.exports = {
  probe,
  mergeVideos,
  buildFilter,
  ensureExecutable,
};
