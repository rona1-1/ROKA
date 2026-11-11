# MCP Media Generator + Video Merger Service

مشروعان متكاملان في مستودع واحد:

1. **MCP Media Generator** (`mcp-media-generator/`) — خادم MCP (Next.js) لتوليد الصور والفيديو بالذكاء الاصطناعي عبر kie.ai و CometAPI، مع نظام مفاتيح متسلسلة تلقائي ودمج مقاطع، ولوحة إدارة عربية RTL.

2. **Video Merger Service** (`merger-service/`) — خدمة مستقلة لدمج الفيديوهات بـ ffmpeg واجهة API عامة + واجهة HTML عربية، جاهزة للنشر على Vercel. تُخزّن كل شيء في Turso (Blobs) دون S3.

> **العلاقة بينهما:** المشروع 1 يستدعي خدمة المشروع 2 عبر `MERGER_API_BASE` لتنفيذ أداة `merge_videos`.

---

## البنية

```
.
├── mcp-media-generator/      # المشروع 1: Next.js + MCP server
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx            # RTL + خط عربي
│   │   │   ├── page.tsx              # لوحة الإدارة (3 بطاقات)
│   │   │   ├── globals.css
│   │   │   ├── mcp/route.ts          # مسار /mcp (Streamable HTTP)
│   │   │   └── api/
│   │   │       ├── health/route.ts
│   │   │       ├── keys/route.ts
│   │   │       ├── keys/[id]/route.ts
│   │   │       └── tasks/route.ts
│   │   ├── lib/
│   │   │   ├── turso.ts              # عميل Turso + المخطط + CRUD
│   │   │   ├── models.ts             # سجل MODELS
│   │   │   ├── errors.ts             # تصنيف أخطاء المزودين
│   │   │   ├── keypool.ts            # نظام المفاتيح المتسلسلة + maskKey
│   │   │   ├── generator.ts          # runGeneration + runMerge (قلب التبديل)
│   │   │   ├── merger.ts             # عميل خدمة الدمج
│   │   │   ├── mcp-server.ts         # 5 أدوات MCP
│   │   │   └── providers/
│   │   │       ├── types.ts
│   │   │       ├── kie.ts            # مزود kie.ai
│   │   │       └── cometapi.ts       # مزود CometAPI
│   │   └── components/
│   ├── package.json
│   ├── .env.example
│   └── .gitignore
│
├── merger-service/           # المشروع 2: Node.js + Vercel serverless
│   ├── api/
│   │   ├── jobs/index.js             # POST /api/jobs
│   │   ├── jobs/[id]/index.js        # GET, DELETE
│   │   ├── jobs/[id]/process.js      # POST (تنفيذ الدمج)
│   │   ├── jobs/[id]/video.js        # GET (بث Range)
│   │   ├── upload.js                 # POST (رفع أجزاء)
│   │   ├── config.js                 # GET
│   │   └── cron.js                   # GET (تنظيف يومي)
│   ├── lib/
│   │   ├── db.js                     # Turso + blob chunked storage
│   │   ├── merge.js                  # محرك ffmpeg
│   │   └── utils.js
│   ├── public/index.html             # واجهة عربية RTL
│   ├── scripts/dev-server.js         # خادم تطوير محلي
│   ├── vercel.json
│   ├── package.json
│   ├── .env.example
│   └── .gitignore
│
└── README.md
```

---

## المتطلبات

- Node.js 18+ (أو Bun)
- قاعدة Turso (مجانية)
- مفتاح kie.ai API
- حساب Vercel + GitHub

---

## 1) إعداد قاعدة Turso (مشترك للمشروعين)

```bash
# ثبّت Turso CLI
curl -sSfL https://get.tur.so/install.sh | bash

# سجّل الدخول
turso auth login

# أنشئ قاعدة (يمكن استخدام نفس القاعدة للمشروعين)
turso db create rona

# احصل على الرابط والتوكن
turso db show rona --url
# → libsql://rona-<org>.turso.io

turso db tokens create rona
# → eyJhbGciOiJF...
```

القيمتان ضروريتان للمشروعين معًا.

---

## 2) تشغيل محلي

### المشروع 1: MCP Media Generator

```bash
cd mcp-media-generator
npm install
cp .env.example .env.local
# املأ .env.local بقيم Turso و MERGER_API_BASE
npm run dev
# → http://localhost:3000
```

### المشروع 2: Video Merger Service

```bash
cd merger-service
npm install
cp .env.example .env
# املأ .env بقيم Turso
npm run dev
# → http://localhost:3001
```

### اختبار سريع

```bash
# فحص صحة المشروع 1
curl http://localhost:3000/api/health

# إضافة مفتاح kie
curl -X POST http://localhost:3000/api/keys \
  -H "Content-Type: application/json" \
  -d '{"provider":"kie","api_key":"YOUR_KEY","label":"main"}'

# تهيئة جلسة MCP
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# فحص خدمة الدمج
curl http://localhost:3001/api/config

# دمج مقطعين
curl -X POST http://localhost:3001/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'
```

---

## 3) النشر على Vercel

### الخطوة 1: ارفع المستودع إلى GitHub

```bash
cd /home/z/my-project
git init
git add .
git commit -m "feat: MCP Media Generator + Video Merger Service"
git branch -M main
git remote add origin https://github.com/rona1-1/ROKA.git
git push -u origin main
```

### الخطوة 2: انشر خدمة الدمج أولًا (merger-service)

1. اذهب إلى https://vercel.com/new
2. استورد المستودع `rona1-1/ROKA`
3. **Root Directory:** `merger-service`
4. **Build Command:** اتركها فارغة (مشروع Node.js خالص بدون بناء)
5. **Output Directory:** اتركها فارغة
6. **Environment Variables:**
   - `TURSO_DATABASE_URL` = `libsql://rona-ronaro.aws-ca-central-1.turso.io`
   - `TURSO_AUTH_TOKEN` = `<توكن Turso>`
   - (اختياري) `MAX_SOURCES`, `SOURCE_MAX_MB`, `OUTPUT_MAX_MB`, `MAX_TOTAL_DURATION_SEC`, `FFMPEG_PRESET`
7. Deploy → ستحصل على رابط مثل `https://merger-service-xxx.vercel.app`

### الخطوة 3: انشر خادم MCP (mcp-media-generator)

1. مشروع جديد في Vercel من نفس المستودع `rona1-1/ROKA`
2. **Root Directory:** `mcp-media-generator`
3. **Framework Preset:** Next.js (يكتشف تلقائيًا)
4. **Environment Variables:**
   - `TURSO_DATABASE_URL` = نفس قيمة المشروع 2
   - `TURSO_AUTH_TOKEN` = نفس قيمة المشروع 2
   - `MERGER_API_BASE` = رابط نشر المشروع 2 (مثل `https://merger-service-xxx.vercel.app`)
   - (اختياري) `MCP_ACCESS_TOKEN` لتأمين /mcp بـ Bearer
5. Deploy → ستحصل على رابط مثل `https://mcp-media-generator-xxx.vercel.app`

### الخطوة 4: أضف مفتاح kie.ai

- افتح رابط المشروع 1 المنشور
- في بطاقة "مدير المفاتيح" أضف مفتاح kie.ai

### الخطوة 5: اربط عميل MCP

في ChatGPT/Claude Desktop/Cursor استخدم JSON جاهز من بطاقة "ربط السيرفر" في الواجهة.

---

## 4) توثيق API

### المشروع 1: MCP Server

| الأداة | الوصف |
|---|---|
| `generate_image` | توليد صورة بـ `gpt-image-2-6/flare-text-to-image` |
| `generate_video` | توليد فيديو بصوت متزامن بـ `grok-imagine-video-1-5-preview` |
| `merge_videos` | دمج مقاطع في فيديو واحد (urls أو task_ids) |
| `get_task` | تتبع أي مهمة حتى الاكتمال |
| `list_media` | استرجاع الوسائط السابقة |

**مسار MCP:** `POST /mcp` (Streamable HTTP, JSON-RPC 2.0)

### المشروع 2: Merger API

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة دمج |
| `POST` | `/api/upload?job=&source=&seq=` | رفع أجزاء (≤4MB) |
| `POST` | `/api/jobs/:id/process` | تنفيذ الدمج (متزامن) |
| `GET` | `/api/jobs/:id` | الحالة + التقدم |
| `GET` | `/api/jobs/:id/video` | بث الناتج (Range 206) |
| `DELETE` | `/api/jobs/:id` | حذف فوري |
| `GET` | `/api/config` | الحدود + version |
| `GET` | `/api/cron` | تنظيف يومي |

---

## 5) القواعد الجوهرية (المشروع 1)

1. **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر.
2. **ترتيب المفاتيح تسلسلي صارم** بترتيب الإضافة (`created_at ASC`) — لا round-robin.
3. **لا توقف عند نفاد رصيد** — انتقال تلقائي للمفتاح التالي واستئناف نفس المهمة بنفس `task_id`.
4. **النموذج لا يرى أخطاء مفاتيح/رصيد** — التبديل صامت تمامًا.
5. مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد محاولتها مع كل `get_task`.
6. أخطاء خدمة الدمج المعلنة = فشل حتمي فوري؛ أخطاء شبكتنا = مؤقتة.
7. ملفات الدمج تُحذف بعد 24 ساعة.
8. كل الرسائل بالعربية (المصطلحات التقنية بالإنجليزية).
9. إخفاء المفاتيح إلزامي في كل الاستجابات.
10. `.env*` مستثنى من Git.

---

## 6) حدود الخطة المجانية (Vercel + Turso)

### Vercel Hobby
- **مدة الدالة:** 10 ثوانٍ افتراضيًا، يمكن رفعها إلى 60ث عبر `maxDuration` (300ث في `vercel.json` يحتاج خطة Pro).
- **حجم الطلب:** ~4.5MB — لذا رفع الملفات يكون أجزاء 4MB.
- **Bandwidth:** 100GB/شهر.
- **Function Executions:** 100,000/شهر.

### Turso Free
- **حجم القاعدة:** 9GB.
- **عدد القواعد:** 500.
- **Rows read:** 1 مليار/شهر، Rows written: 25 مليون/شهر.
- **HTTP requests:** 10,000/يوم (يكفي للاستخدام المتوسط).

### ffmpeg
- `ffmpeg-static` حجم الثنائي ~70MB — قد يبطئ النشر قليلًا لكنه يعمل.
- معالجة فيديو 150MB تستغرق ~30-60 ثانية على Vercel.

---

## 7) ملاحظات أمنية

- لا تُرفع ملفات `.env` / `.env.local` إلى Git — وهي في `.gitignore`.
- المفاتيح تُخفى دائمًا في الواجهة والسجلات (`maskKey`).
- إن ضبطت `MCP_ACCESS_TOKEN` يُطلب Bearer token على `/mcp`.
- **أنصح بتدوير (rotate) كل المفاتيح التي شاركتها في المحادثة** (kie.ai API key, GitHub PAT, Turso token).

---

## 8) استكشاف الأخطاء

### `SQL_MANY_STATEMENTS`
libSQL لا يقبل عبارات متعددة في سلسلة واحدة — كل عبارة في `batch` منفصلة. (تمت معالجته.)

### `muxer does not support non seekable output`
ffmpeg مع `+faststart` يحتاج ملف إخراج (وليس stdout). (تمت معالجته — الإخراج إلى `/tmp`.)

### خدمة الدمج غير متصلة
تحقق من `MERGER_API_BASE` في المشروع 1، وأن خدمة الدمج منشورة وتعمل على `/api/config`.

### Next.js dev server غير مستقر
خادم التطوير المحلي قد يتوقف — أعد تشغيله. في الإنتاج (Vercel) لا توجد هذه المشكلة.

---

## الترخيص

MIT — استخدم بحرية.
