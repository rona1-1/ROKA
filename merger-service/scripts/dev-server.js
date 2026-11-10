/**
 * scripts/dev-server.js — خادم تطوير محلي يحاكي بيئة Vercel.
 *
 * يحلّل المسارات الديناميكية ويضعها في req.query.
 * يوجّه /api/jobs, /api/jobs/:id, /api/jobs/:id/process, /api/jobs/:id/video,
 * /api/upload, /api/config, /api/cron إلى دوال api/ المناسبة.
 * يخدم public/index.html للمسار /.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = Number(process.env.PORT || 3001);
const ROOT = path.join(__dirname, "..");

// تحميل .env يدويًا
function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

// معالج استثناءات شامل حتى لا يتوقف السيرفر
process.on("uncaughtException", (e) => console.error("Uncaught:", e));
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e));

/** يحلّل المسار ويُرجع ملف الدالة + query params. */
function resolveApiHandler(pathname) {
  // /api/jobs/:id/process
  let m = pathname.match(/^\/api\/jobs\/([^/]+)\/process$/);
  if (m) return { file: "api/jobs/[id]/process.js", query: { id: m[1] } };
  // /api/jobs/:id/video
  m = pathname.match(/^\/api\/jobs\/([^/]+)\/video$/);
  if (m) return { file: "api/jobs/[id]/video.js", query: { id: m[1] } };
  // /api/jobs/:id
  m = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (m) return { file: "api/jobs/[id]/index.js", query: { id: m[1] } };
  // /api/jobs
  if (pathname === "/api/jobs") return { file: "api/jobs/index.js", query: {} };
  // /api/upload
  if (pathname === "/api/upload") return { file: "api/upload.js", query: {} };
  // /api/config
  if (pathname === "/api/config") return { file: "api/config.js", query: {} };
  // /api/cron
  if (pathname === "/api/cron") return { file: "api/cron.js", query: {} };
  return null;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = { ...parsed.query };

  // Polyfill: Express-like API على res (status, json, setHeader, end)
  // حتى تعمل دوال api/ كما تعمل على @vercel/node.
  res.status = function (code) { res.statusCode = code; return res; };
  res.json = function (obj) {
    const body = JSON.stringify(obj);
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(body);
    return res;
  };
  res.send = function (body) { res.end(body); return res; };

  // CORS مفتوح
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Range, mcp-session-id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // مسارات API
  if (pathname.startsWith("/api/")) {
    const handler = resolveApiHandler(pathname);
    if (!handler) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "المسار غير موجود" }));
    }
    try {
      const mod = require(path.join(ROOT, handler.file));
      req.query = { ...query, ...handler.query };
      // قراءة الجسم للـ POST/PATCH
      if (req.method === "POST" || req.method === "PATCH") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks);
        const ct = req.headers["content-type"] || "";
        if (ct.includes("application/json")) {
          try { req.body = JSON.parse(raw.toString("utf8")); }
          catch { req.body = raw.toString("utf8"); }
        } else {
          req.body = raw;
        }
      }
      // أمسك أخطاء async غير الملقاة
      await Promise.resolve(mod(req, res)).catch((e) => {
        console.error("API async error:", e);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } catch (e) {
      console.error("API error:", e);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // خدمة الملفات الثابتة
  let filePath = pathname === "/" ? "public/index.html" : `public${pathname}`;
  const full = path.join(ROOT, filePath);
  if (fs.existsSync(full) && fs.statSync(full).isFile()) {
    const ext = path.extname(full);
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    fs.createReadStream(full).pipe(res);
    return;
  }

  // أي مسار آخر → index.html (SPA fallback)
  const idx = path.join(ROOT, "public/index.html");
  if (fs.existsSync(idx)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    fs.createReadStream(idx).pipe(res);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`✅ Video Merger Service running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/config`);
});
