"use client";

/**
 * src/app/page.tsx — لوحة الإدارة العربية (Dashboard).
 * ثلاث بطاقات: مدير المفاتيح + لوحة المهام + ربط السيرفر.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, Copy, Check, Key, Plus, RefreshCw, Trash2, Power, Link2,
  Film, Image as ImageIcon, Video, Layers, AlertCircle, CheckCircle2,
  Clock, XCircle, Loader2,
} from "lucide-react";

interface KeyRow {
  id: string; provider: string; label: string; masked: string;
  status: string; usage_count: number; success_count: number; fail_count: number;
  last_used_at: string | null; last_error: string | null; created_at: string;
}
interface TaskRow {
  id: string; type: string; status: string; progress: number; model: string;
  prompt: string; provider: string | null; result_urls: string[];
  error_message: string | null; attempts: any[]; created_at: string;
  completed_at: string | null;
}
interface Health {
  ok: boolean; database: string; mcpEndpoint: string; models: any[];
  merger: { base: string; healthy: boolean }; authRequired: boolean;
}

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [tasks, setTasks] = useState<{ stats: any; tasks: TaskRow[] } | null>(null);
  const [origin, setOrigin] = useState("");

  const loadHealth = useCallback(async () => {
    try { const r = await fetch("/api/health"); setHealth(await r.json()); } catch {}
  }, []);
  const loadKeys = useCallback(async () => {
    try { const r = await fetch("/api/keys"); const d = await r.json(); setKeys(d.keys || []); } catch {}
  }, []);
  const loadTasks = useCallback(async () => {
    try { const r = await fetch("/api/tasks?limit=20"); setTasks(await r.json()); } catch {}
  }, []);

  useEffect(() => {
    loadHealth(); loadKeys(); loadTasks();
    setOrigin(window.location.origin);
    const h = setInterval(loadHealth, 30000);
    const t = setInterval(loadTasks, 5000);
    return () => { clearInterval(h); clearInterval(t); };
  }, [loadHealth, loadKeys, loadTasks]);

  return (
    <main className="min-h-screen flex flex-col">
      <Header health={health} />
      <div className="flex-1 max-w-7xl mx-auto w-full px-4 py-6 space-y-6">
        <KeyManager keys={keys} reload={loadKeys} />
        <TaskPanel data={tasks} reload={loadTasks} />
        <ServerConnection health={health} origin={origin} />
      </div>
      <Footer />
    </main>
  );
}

function Header({ health }: { health: Health | null }) {
  const dbOk = health?.database === "turso-connected";
  const mergerOk = health?.merger?.healthy;
  return (
    <header className="border-b border-[var(--border)] bg-[var(--bg-card)]/60 backdrop-blur sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent-2)] flex items-center justify-center">
            <Layers className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">MCP Media Generator</h1>
            <p className="text-xs text-[var(--text-soft)]">خادم MCP لتوليد الصور والفيديو ودمج المقاطع</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge ok={dbOk} okLabel="Turso متصل" failLabel="Turso غير متصل" />
          <Badge ok={mergerOk} okLabel="خدمة الدمج جاهزة" failLabel="خدمة الدمج غير متصلة" />
          {health?.authRequired && (
            <span className="badge badge-warning"><AlertCircle className="w-3 h-3" /> /mcp محمي بـ Bearer</span>
          )}
        </div>
      </div>
    </header>
  );
}

function Badge({ ok, okLabel, failLabel }: { ok?: boolean; okLabel: string; failLabel: string }) {
  return (
    <span className={`badge ${ok ? "badge-success" : "badge-danger"}`}>
      {ok ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {ok ? okLabel : failLabel}
    </span>
  );
}

function Footer() {
  return (
    <footer className="border-t border-[var(--border)] py-4 text-center text-xs text-[var(--text-soft)]">
      MCP Media Generator v1.2.0 —{" "}
      <a href="/mcp" className="text-[var(--accent)] hover:underline" target="_blank" rel="noreferrer">/mcp</a>
      {" · "}
      <a href="/api/health" className="text-[var(--accent)] hover:underline" target="_blank" rel="noreferrer">/api/health</a>
    </footer>
  );
}

/* ===================== مدير المفاتيح ===================== */

function KeyManager({ keys, reload }: { keys: KeyRow[]; reload: () => void }) {
  const [provider, setProvider] = useState<"kie" | "cometapi">("kie");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const addKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setSubmitting(true); setErr(null);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() || undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "فشل الإضافة");
      setApiKey(""); setLabel("");
      reload();
    } catch (e: any) { setErr(e.message); }
    finally { setSubmitting(false); }
  };

  const toggleStatus = async (k: KeyRow) => {
    const next = k.status === "disabled" ? "active" : "disabled";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    reload();
  };
  const remove = async (k: KeyRow) => {
    if (!confirm(`حذف مفتاح "${k.label || k.provider}" نهائيًا؟`)) return;
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    reload();
  };

  return (
    <section className="card">
      <div className="flex items-center gap-2 mb-3">
        <Key className="w-5 h-5 text-[var(--accent)]" />
        <h2 className="text-lg font-bold">مدير المفاتيح</h2>
      </div>
      <div className="bg-[rgba(56,189,248,0.08)] border border-[rgba(56,189,248,0.2)] rounded-lg p-3 mb-4 text-sm text-[var(--text-soft)]">
        أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
      </div>

      <form onSubmit={addKey} className="grid grid-cols-1 md:grid-cols-12 gap-3 mb-4">
        <select
          className="input md:col-span-2"
          value={provider}
          onChange={(e) => setProvider(e.target.value as any)}
        >
          <option value="kie">kie.ai</option>
          <option value="cometapi">CometAPI</option>
        </select>
        <input
          className="input md:col-span-3"
          placeholder="تسمية اختيارية (مثل: حساب العمل)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <input
          className="input md:col-span-5"
          placeholder="المفتاح (api_key)"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          dir="ltr"
        />
        <button type="submit" className="btn btn-primary md:col-span-2" disabled={submitting}>
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          إضافة
        </button>
      </form>
      {err && <div className="text-sm text-[var(--danger)] mb-3">{err}</div>}

      <div className="space-y-2 max-h-96 overflow-y-auto">
        {keys.length === 0 ? (
          <div className="text-center text-[var(--text-soft)] py-8 text-sm">
            لا توجد مفاتيح بعد. أضف مفتاحًا واحدًا على الأقل لبدء التوليد.
          </div>
        ) : (
          keys.map((k) => <KeyRowCard key={k.id} k={k} onToggle={() => toggleStatus(k)} onDelete={() => remove(k)} />)
        )}
      </div>
    </section>
  );
}

function KeyRowCard({ k, onToggle, onDelete }: { k: KeyRow; onToggle: () => void; onDelete: () => void }) {
  const statusBadge =
    k.status === "active" ? <span className="badge badge-success"><CheckCircle2 className="w-3 h-3" /> نشط</span>
    : k.status === "exhausted" ? <span className="badge badge-warning"><AlertCircle className="w-3 h-3" /> مستنزف</span>
    : <span className="badge badge-muted"><XCircle className="w-3 h-3" /> معطّل</span>;

  return (
    <div className="bg-[var(--bg-soft)] rounded-xl p-3 border border-[var(--border)]">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="badge badge-info">{k.provider}</span>
            {statusBadge}
            {k.label && <span className="text-sm text-[var(--text-soft)]">{k.label}</span>}
          </div>
          <div className="font-mono text-sm text-[var(--text-soft)]" dir="ltr">{k.masked}</div>
          <div className="text-xs text-[var(--text-soft)] mt-1 flex gap-3 flex-wrap">
            <span>استخدام: {k.usage_count}</span>
            <span className="text-[var(--success)]">نجاح: {k.success_count}</span>
            <span className="text-[var(--danger)]">فشل: {k.fail_count}</span>
          </div>
          {k.last_error && (
            <div className="text-xs text-[var(--danger)] mt-1 truncate" title={k.last_error}>
              آخر خطأ: {k.last_error}
            </div>
          )}
        </div>
        <div className="flex gap-1">
          <button onClick={onToggle} className="btn btn-ghost !px-2" title={k.status === "disabled" ? "تنشيط" : "تعطيل"}>
            <Power className="w-4 h-4" />
          </button>
          <button onClick={onDelete} className="btn btn-danger !px-2" title="حذف">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ===================== لوحة المهام ===================== */

function TaskPanel({ data, reload }: { data: { stats: any; tasks: TaskRow[] } | null; reload: () => void }) {
  const s = data?.stats;
  return (
    <section className="card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-[var(--accent)]" />
          <h2 className="text-lg font-bold">لوحة المهام</h2>
        </div>
        <button onClick={reload} className="btn btn-ghost !py-1 !px-2 text-sm">
          <RefreshCw className="w-4 h-4" /> تحديث
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard label="إجمالي" value={s?.total ?? 0} color="var(--accent)" />
        <StatCard label="مكتملة" value={s?.completed ?? 0} color="var(--success)" />
        <StatCard label="فاشلة" value={s?.failed ?? 0} color="var(--danger)" />
        <StatCard label="جارية" value={s?.processing ?? 0} color="var(--warning)" />
      </div>

      <div className="space-y-2 max-h-[500px] overflow-y-auto">
        {data?.tasks.length === 0 || !data ? (
          <div className="text-center text-[var(--text-soft)] py-8 text-sm">لا توجد مهام بعد.</div>
        ) : (
          data.tasks.map((t) => <TaskRowCard key={t.id} t={t} />)
        )}
      </div>
    </section>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-[var(--bg-soft)] rounded-xl p-3 border border-[var(--border)]">
      <div className="text-2xl font-bold" style={{ color }}>{value}</div>
      <div className="text-xs text-[var(--text-soft)]">{label}</div>
    </div>
  );
}

function TaskRowCard({ t }: { t: TaskRow }) {
  const typeIcon =
    t.type === "image" ? <ImageIcon className="w-4 h-4" /> :
    t.type === "video" ? <Video className="w-4 h-4" /> :
    <Layers className="w-4 h-4" />;
  const statusBadge =
    t.status === "completed" ? <span className="badge badge-success"><CheckCircle2 className="w-3 h-3" /> مكتملة</span>
    : t.status === "failed" ? <span className="badge badge-danger"><XCircle className="w-3 h-3" /> فاشلة</span>
    : t.status === "processing" ? <span className="badge badge-warning"><Loader2 className="w-3 h-3 animate-spin" /> جارية</span>
    : <span className="badge badge-muted"><Clock className="w-3 h-3" /> بالانتظار</span>;

  return (
    <div className="bg-[var(--bg-soft)] rounded-xl p-3 border border-[var(--border)]">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            {typeIcon}
            <span className="text-sm text-[var(--text-soft)]">{t.model}</span>
            {statusBadge}
            {t.attempts.length > 0 && (
              <span className="text-xs text-[var(--text-soft)]">محاولات: {t.attempts.length}</span>
            )}
          </div>
          {t.prompt && <div className="text-xs text-[var(--text-soft)] truncate mb-1">{t.prompt}</div>}
          {(t.status === "processing" || t.status === "pending") && (
            <div className="mt-2">
              <div className="h-2 bg-[var(--bg)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-l from-[var(--accent)] to-[var(--accent-2)] transition-all"
                  style={{ width: `${t.progress}%` }}
                />
              </div>
              <div className="text-xs text-[var(--text-soft)] mt-1">{t.progress}%</div>
            </div>
          )}
          {t.error_message && (
            <div className="text-xs text-[var(--danger)] mt-1">{t.error_message}</div>
          )}
        </div>
        <div className="flex flex-col gap-1 items-end">
          {t.result_urls.length > 0 && (
            t.type === "image" ? (
              <a href={t.result_urls[0]} target="_blank" rel="noreferrer" className="btn btn-ghost !py-1 !px-2 text-xs">
                <Link2 className="w-3 h-3" /> فتح الصورة
              </a>
            ) : (
              <a href={t.result_urls[0]} target="_blank" rel="noreferrer" className="btn btn-ghost !py-1 !px-2 text-xs">
                <Film className="w-3 h-3" /> فتح الفيديو
              </a>
            )
          )}
          <span className="text-xs text-[var(--text-soft)]">{new Date(t.created_at).toLocaleString("ar-EG")}</span>
        </div>
      </div>
    </div>
  );
}

/* ===================== ربط السيرفر ===================== */

function ServerConnection({ health, origin }: { health: Health | null; origin: string }) {
  const mcpUrl = origin ? `${origin}/mcp` : "/mcp";
  const auth = health?.authRequired ? process.env.NEXT_PUBLIC_MCP_TOKEN || "" : "";
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const [copied, setCopied] = useState(false);

  const configs: Record<string, { json: any; note: string }> = {
    chatgpt: {
      json: {
        mcpServers: {
          "media-generator": auth
            ? { url: mcpUrl, headers: { Authorization: `Bearer ${auth}` } }
            : { url: mcpUrl },
        },
      },
      note: "في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».",
    },
    claude: {
      json: {
        mcpServers: {
          "media-generator": auth
            ? { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${auth}` } }
            : { type: "http", url: mcpUrl },
        },
      },
      note: "ضع هذا في ملف claude_desktop_config.json ثم أعد تشغيل Claude Desktop.",
    },
    cursor: {
      json: {
        mcpServers: {
          "media-generator": auth
            ? { url: mcpUrl, headers: { Authorization: `Bearer ${auth}` } }
            : { url: mcpUrl },
        },
      },
      note: "ضع هذا في ملف mcp.json الخاص بـ Cursor / Windsurf / Cline.",
    },
  };

  const copyJson = async () => {
    await navigator.clipboard.writeText(JSON.stringify(configs[tab].json, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const tools = [
    { name: "generate_image", desc: "توليد صورة من وصف نصي بـ gpt-image-2-6" },
    { name: "generate_video", desc: "توليد فيديو بصوت متزامن بـ grok-imagine-video" },
    { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب" },
    { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى الاكتمال" },
    { name: "list_media", desc: "استرجاع الوسائط السابقة من قاعدة البيانات" },
  ];

  return (
    <section className="card">
      <div className="flex items-center gap-2 mb-4">
        <Link2 className="w-5 h-5 text-[var(--accent)]" />
        <h2 className="text-lg font-bold">ربط السيرفر</h2>
      </div>

      <div className="mb-4">
        <label className="text-sm text-[var(--text-soft)] mb-1 block">رابط خادم MCP</label>
        <div className="flex gap-2">
          <input className="input flex-1 font-mono text-sm" dir="ltr" value={mcpUrl} readOnly />
          <button
            onClick={() => { navigator.clipboard.writeText(mcpUrl); }}
            className="btn btn-ghost"
          ><Copy className="w-4 h-4" /> نسخ</button>
        </div>
      </div>

      <div className="flex gap-1 mb-3 border-b border-[var(--border)]">
        {(["chatgpt", "claude", "cursor"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
              tab === t
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-transparent text-[var(--text-soft)] hover:text-[var(--text)]"
            }`}
          >
            {t === "chatgpt" ? "ChatGPT / GPT Agents" : t === "claude" ? "Claude Desktop" : "Cursor / Windsurf / Cline"}
          </button>
        ))}
      </div>

      <div className="relative">
        <pre className="bg-[var(--bg)] rounded-lg p-3 text-xs font-mono overflow-x-auto border border-[var(--border)]" dir="ltr">
{JSON.stringify(configs[tab].json, null, 2)}
        </pre>
        <button onClick={copyJson} className="btn btn-ghost !py-1 !px-2 text-xs absolute top-2 left-2">
          {copied ? <><Check className="w-3 h-3" /> نُسخ</> : <><Copy className="w-3 h-3" /> نسخ JSON</>}
        </button>
      </div>
      <p className="text-xs text-[var(--text-soft)] mt-2">{configs[tab].note}</p>

      <div className="mt-4">
        <h3 className="text-sm font-bold mb-2">الأدوات الخمس</h3>
        <div className="flex flex-wrap gap-2">
          {tools.map((tool) => (
            <span key={tool.name} className="badge badge-info" title={tool.desc}>
              {tool.name}
            </span>
          ))}
        </div>
        <ul className="mt-2 space-y-1">
          {tools.map((tool) => (
            <li key={tool.name} className="text-xs text-[var(--text-soft)]">
              <span className="font-mono text-[var(--accent)]">{tool.name}</span> — {tool.desc}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4 bg-[rgba(245,158,11,0.08)] border border-[rgba(245,158,11,0.2)] rounded-lg p-3 text-sm text-[var(--text-soft)]">
        الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
      </div>
    </section>
  );
}
