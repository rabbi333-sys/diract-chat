import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  getConnections,
  getActiveConnection,
  saveConnection,
  setActiveConnection,
  deleteConnection,
  MAX_CONNECTIONS,
  MainDbConnection,
  MainDbType,
  DB_TYPES,
  getConnectionDisplayUrl,
} from "@/lib/db-config";
import { toast } from "sonner";
import {
  Key,
  CheckCircle2,
  Plus,
  Trash2,
  ArrowRight,
  Loader2,
  ChevronDown,
  ChevronUp,
  Zap,
  Link2,
  Eye,
  EyeOff,
  Server,
  Wifi,
  Copy,
  Check,
  MessageSquare,
  ShoppingCart,
  Users,
  Bot,
  AlertTriangle,
  KeyRound,
  Contact,
  HandIcon,
  BookOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";

const emptyForm = {
  name: "",
  dbType: "supabase" as MainDbType,
  url: "",
  anonKey: "",
  serviceRoleKey: "",
  pgDbPassword: "",
  host: "",
  port: "",
  dbUsername: "",
  dbPassword: "",
  dbName: "",
  connectionString: "",
};

type FormState = typeof emptyForm;

// ─── SQL Setup Guides ─────────────────────────────────────────────────────────

const SETUP_GUIDES = [
  {
    id: "messages",
    icon: <MessageSquare size={15} />,
    title: "Chat / Messages",
    color: "blue",
    description: "Stores all chat messages from n8n AI conversations. This is the main table your n8n workflow writes to.",
    sql: `-- Chat messages table (used by n8n to store AI conversation history)
CREATE TABLE IF NOT EXISTS sessions (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT        NOT NULL,
  message       JSONB       NOT NULL,  -- { type: 'human'|'ai', content: '...' }
  recipient     TEXT,                  -- phone / user identifier
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast session lookups
CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_recipient  ON sessions(recipient);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);

-- Enable Realtime (optional but recommended)
ALTER TABLE sessions REPLICA IDENTITY FULL;`,
  },
  {
    id: "orders",
    icon: <ShoppingCart size={15} />,
    title: "Orders",
    color: "emerald",
    description: "Stores customer orders created via AI chat. Supports multiple courier providers (Pathao, Steadfast, Paperfly, Redex).",
    sql: `-- Orders table
CREATE TABLE IF NOT EXISTS orders (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          TEXT,
  recipient_id        TEXT,
  customer_name       TEXT,
  customer_phone      TEXT,
  customer_address    TEXT,
  product_name        TEXT        NOT NULL,
  sku                 TEXT,
  quantity            INT         NOT NULL DEFAULT 1,
  unit_price          NUMERIC,
  total_price         NUMERIC,
  amount_to_collect   NUMERIC,
  payment_status      TEXT                 DEFAULT 'unpaid',
  status              TEXT        NOT NULL DEFAULT 'pending',
  source              TEXT,
  merchant_order_id   TEXT,
  consignment_id      TEXT,
  notes               TEXT,
  reason_for_cancel   TEXT,
  order_data          JSONB,
  -- Courier stats
  pathao              NUMERIC,
  steadfast           NUMERIC,
  paperfly            NUMERIC,
  redex               NUMERIC,
  total_parcels       NUMERIC,
  total_delivered     NUMERIC,
  total_cancel        NUMERIC,
  order_receive_ratio TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_session_id   ON orders(session_id);
CREATE INDEX IF NOT EXISTS idx_orders_recipient_id ON orders(recipient_id);
CREATE INDEX IF NOT EXISTS idx_orders_status       ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at   ON orders(created_at DESC);

-- Enable Realtime
ALTER TABLE orders REPLICA IDENTITY FULL;`,
  },
  {
    id: "handoff",
    icon: <HandIcon size={15} />,
    title: "Handoff Requests",
    color: "orange",
    description: "When the AI can't handle a conversation, it creates a handoff request for a human agent.",
    sql: `-- Handoff requests table
CREATE TABLE IF NOT EXISTS handoff_requests (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  TEXT,
  recipient   TEXT,
  reason      TEXT        NOT NULL DEFAULT 'Human requested',
  message     TEXT,
  priority    TEXT        NOT NULL DEFAULT 'normal',  -- low | normal | high | urgent
  status      TEXT        NOT NULL DEFAULT 'pending', -- pending | in_progress | resolved
  agent_data  JSONB,
  notes       TEXT,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_handoff_status     ON handoff_requests(status);
CREATE INDEX IF NOT EXISTS idx_handoff_session_id ON handoff_requests(session_id);
CREATE INDEX IF NOT EXISTS idx_handoff_created_at ON handoff_requests(created_at DESC);

-- Enable Realtime
ALTER TABLE handoff_requests REPLICA IDENTITY FULL;`,
  },
  {
    id: "ai_control",
    icon: <Bot size={15} />,
    title: "AI Control",
    color: "violet",
    description: "Controls whether the AI is enabled or disabled per chat session. Allows agents to pause/resume AI responses.",
    sql: `-- AI control table (per-session AI on/off toggle)
CREATE TABLE IF NOT EXISTS ai_control (
  session_id  TEXT        PRIMARY KEY,
  ai_enabled  BOOLEAN     NOT NULL DEFAULT TRUE,
  user_id     TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Realtime so toggle updates instantly
ALTER TABLE ai_control REPLICA IDENTITY FULL;`,
  },
  {
    id: "failed",
    icon: <AlertTriangle size={15} />,
    title: "Failed Automations",
    color: "red",
    description: "Logs errors from automation workflows so you can investigate and resolve them.",
    sql: `-- Failed automations / error log table
CREATE TABLE IF NOT EXISTS failed_automations (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     TEXT,
  user_id        TEXT,
  recipient      TEXT,
  workflow_name  TEXT,
  error_message  TEXT        NOT NULL,
  error_details  JSONB,
  severity       TEXT        DEFAULT 'error',   -- warning | error | critical
  source         TEXT,
  resolved       BOOLEAN     DEFAULT FALSE,
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_failed_resolved   ON failed_automations(resolved);
CREATE INDEX IF NOT EXISTS idx_failed_created_at ON failed_automations(created_at DESC);

-- Enable Realtime
ALTER TABLE failed_automations REPLICA IDENTITY FULL;`,
  },
  {
    id: "team",
    icon: <Users size={15} />,
    title: "Team Management",
    color: "indigo",
    description: "Manage your team members and control their access with roles and permissions.",
    sql: `-- App owner table (single owner claim)
CREATE TABLE IF NOT EXISTS app_owner (
  user_id    TEXT        PRIMARY KEY,
  claimed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Team invites table
CREATE TABLE IF NOT EXISTS team_invites (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by       TEXT         NOT NULL,
  email            TEXT         NOT NULL,
  role             TEXT         NOT NULL DEFAULT 'agent',
  permissions      TEXT[]       NOT NULL DEFAULT '{}',
  token            TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  status           TEXT         NOT NULL DEFAULT 'pending', -- pending | accepted | revoked
  accepted_user_id TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_invites_token ON team_invites(token);
CREATE INDEX        IF NOT EXISTS idx_team_invites_email ON team_invites(email);`,
  },
  {
    id: "api_keys",
    icon: <KeyRound size={15} />,
    title: "API Keys",
    color: "cyan",
    description: "Stores API keys for webhook authentication and external integrations.",
    sql: `-- API keys table
CREATE TABLE IF NOT EXISTS api_keys (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT        NOT NULL,
  label      TEXT,
  api_key    TEXT        NOT NULL DEFAULT concat('sk-', gen_random_uuid()::text),
  is_active  BOOLEAN     DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key     ON api_keys(api_key);
CREATE INDEX        IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);`,
  },
  {
    id: "contacts",
    icon: <Contact size={15} />,
    title: "Contacts / Recipients",
    color: "pink",
    description: "Maps recipient IDs (phone numbers / user IDs) to human-readable names.",
    sql: `-- Recipient names / contacts table
CREATE TABLE IF NOT EXISTS recipient_names (
  recipient_id TEXT        PRIMARY KEY,
  name         TEXT        NOT NULL,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);`,
  },
];

const COLOR_MAP: Record<string, { badge: string; dot: string; ring: string; icon: string }> = {
  blue:   { badge: "bg-blue-100 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300",   dot: "bg-blue-500",   ring: "ring-blue-200 dark:ring-blue-800",   icon: "text-blue-500" },
  emerald:{ badge: "bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500", ring: "ring-emerald-200 dark:ring-emerald-800", icon: "text-emerald-500" },
  orange: { badge: "bg-orange-100 dark:bg-orange-950/50 text-orange-700 dark:text-orange-300", dot: "bg-orange-500", ring: "ring-orange-200 dark:ring-orange-800", icon: "text-orange-500" },
  violet: { badge: "bg-violet-100 dark:bg-violet-950/50 text-violet-700 dark:text-violet-300", dot: "bg-violet-500", ring: "ring-violet-200 dark:ring-violet-800", icon: "text-violet-500" },
  red:    { badge: "bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-300",         dot: "bg-red-500",    ring: "ring-red-200 dark:ring-red-800",     icon: "text-red-500" },
  indigo: { badge: "bg-indigo-100 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300", dot: "bg-indigo-500", ring: "ring-indigo-200 dark:ring-indigo-800", icon: "text-indigo-500" },
  cyan:   { badge: "bg-cyan-100 dark:bg-cyan-950/50 text-cyan-700 dark:text-cyan-300",     dot: "bg-cyan-500",   ring: "ring-cyan-200 dark:ring-cyan-800",   icon: "text-cyan-500" },
  pink:   { badge: "bg-pink-100 dark:bg-pink-950/50 text-pink-700 dark:text-pink-300",     dot: "bg-pink-500",   ring: "ring-pink-200 dark:ring-pink-800",   icon: "text-pink-500" },
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-all",
        copied
          ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400"
          : "bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground"
      )}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? "Copied!" : "Copy SQL"}
    </button>
  );
}

function SetupGuideSection() {
  const [openId, setOpenId] = useState<string | null>("messages");
  const [allOpen, setAllOpen] = useState(false);

  const toggleAll = () => {
    if (allOpen) { setOpenId(null); setAllOpen(false); }
    else { setAllOpen(true); }
  };

  return (
    <div className="w-full max-w-[440px] mt-6">
      <div className="rounded-2xl border border-border/50 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-xl shadow-xl shadow-black/5 overflow-hidden">
        {/* Section header */}
        <div className="px-5 py-4 border-b border-border/40 bg-gradient-to-r from-slate-50/80 to-zinc-50/40 dark:from-zinc-800/40 dark:to-zinc-900/20 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-slate-600 to-slate-800 flex items-center justify-center">
              <BookOpen size={13} className="text-white" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-foreground">Database Setup Guide</h3>
              <p className="text-[10px] text-muted-foreground">Run these SQL scripts in your Supabase SQL Editor</p>
            </div>
          </div>
          <button
            onClick={toggleAll}
            className="text-[11px] text-blue-500 hover:text-blue-600 font-semibold transition-colors"
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        </div>

        {/* Info banner */}
        <div className="mx-4 mt-4 mb-1 px-3.5 py-3 rounded-xl bg-blue-50/80 dark:bg-blue-950/30 border border-blue-200/60 dark:border-blue-800/40 flex items-start gap-2.5">
          <Zap size={13} className="text-blue-500 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-blue-700 dark:text-blue-300 leading-relaxed">
            <strong>One database, all features.</strong> Connect your Supabase project once above and all tabs — Messages, Orders, Handoffs, Team, AI Control — will use the same database automatically.
          </p>
        </div>

        {/* Guides */}
        <div className="p-4 space-y-2">
          {SETUP_GUIDES.map((guide) => {
            const isOpen = allOpen || openId === guide.id;
            const colors = COLOR_MAP[guide.color];
            return (
              <div
                key={guide.id}
                className={cn(
                  "rounded-xl border overflow-hidden transition-all",
                  isOpen ? `ring-1 ${colors.ring} border-transparent` : "border-border/40"
                )}
              >
                {/* Accordion header */}
                <button
                  className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/30 transition-colors"
                  onClick={() => {
                    if (allOpen) { setAllOpen(false); setOpenId(openId === guide.id ? null : guide.id); }
                    else { setOpenId(openId === guide.id ? null : guide.id); }
                  }}
                >
                  <div className={cn("w-2 h-2 rounded-full flex-shrink-0", colors.dot)} />
                  <span className={cn("flex-shrink-0", colors.icon)}>{guide.icon}</span>
                  <span className="flex-1 text-sm font-semibold text-foreground">{guide.title}</span>
                  <span className={cn("text-[10px] font-semibold px-2 py-0.5 rounded-full hidden sm:inline-flex", colors.badge)}>
                    1 table
                  </span>
                  {isOpen ? <ChevronUp size={13} className="text-muted-foreground flex-shrink-0" /> : <ChevronDown size={13} className="text-muted-foreground flex-shrink-0" />}
                </button>

                {/* Accordion body */}
                {isOpen && (
                  <div className="px-4 pb-4">
                    <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed">{guide.description}</p>
                    <div className="relative rounded-xl overflow-hidden border border-border/40">
                      <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/95 dark:bg-zinc-950 border-b border-white/10">
                        <span className="text-[10px] text-zinc-400 font-mono font-semibold">SQL</span>
                        <CopyButton text={guide.sql} />
                      </div>
                      <pre className="bg-zinc-900/95 dark:bg-zinc-950 text-zinc-200 text-[10.5px] font-mono leading-relaxed p-4 overflow-x-auto whitespace-pre-wrap break-words">
                        {guide.sql}
                      </pre>
                    </div>
                    <p className="text-[10px] text-muted-foreground/60 mt-2">
                      Run this in <span className="font-semibold text-muted-foreground">Supabase → SQL Editor → New Query</span>
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

const EMAIL_NOTICE_KEY = "meta_email_notice_dismissed";

const ConnectDB = () => {
  const [connections, setConnections] = useState<MainDbConnection[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [setupStatus, setSetupStatus] = useState<"idle" | "running" | "done" | "partial" | "failed">("idle");
  const [showPassword, setShowPassword] = useState(false);
  const [showServiceKey, setShowServiceKey] = useState(false);
  const [showPgPassword, setShowPgPassword] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [noticeDismissed, setNoticeDismissed] = useState(() => localStorage.getItem(EMAIL_NOTICE_KEY) === "1");

  const reload = () => {
    const conns = getConnections();
    const active = getActiveConnection();
    setConnections(conns);
    setActiveId(active?.id || null);
    if (conns.length === 0) setShowForm(true);
  };

  useEffect(() => { reload(); }, []);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm(f => ({ ...f, [key]: value }));
    setTestOk(null);
  };

  const currentType = DB_TYPES.find(t => t.value === form.dbType)!;

  const canTest = () => {
    if (form.dbType === 'supabase') return !!form.url.trim() && !!form.anonKey.trim();
    if (form.dbType === 'postgresql' || form.dbType === 'mysql') return !!form.host.trim() && !!form.dbUsername.trim();
    return !!form.connectionString.trim();
  };

  const canSave = () => {
    if (!form.name.trim()) return false;
    return canTest();
  };

  const testConnection = async () => {
    if (!canTest()) { toast.error("Please fill in the required fields"); return; }
    setTesting(true);
    setTestOk(null);
    try {
      if (form.dbType === 'supabase') {
        const client = createClient(form.url.trim(), form.anonKey.trim(), {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { error } = await client.auth.getSession();
        if (error && !error.message.toLowerCase().includes("refresh token")) throw error;
        setTestOk(true);
        toast.success("Connection successful!");
      } else {
        setTestOk(true);
        toast.success("Settings valid!");
      }
    } catch (e) {
      setTestOk(false);
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("Connection failed: " + msg);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error("Please enter a connection name"); return; }
    if (!canTest()) { toast.error("Please fill in the required fields"); return; }
    setSaving(true);
    try {
      const base = { name: form.name.trim(), dbType: form.dbType, url: '', anonKey: '' };
      let conn: Omit<MainDbConnection, 'id' | 'createdAt'>;
      if (form.dbType === 'supabase') {
        conn = { ...base, url: form.url.trim(), anonKey: form.anonKey.trim(), serviceRoleKey: form.serviceRoleKey.trim() || undefined };
      } else if (form.dbType === 'postgresql' || form.dbType === 'mysql') {
        conn = { ...base, host: form.host.trim(), port: form.port.trim() || currentType.defaultPort, dbUsername: form.dbUsername.trim(), dbPassword: form.dbPassword, dbName: form.dbName.trim() };
      } else {
        conn = { ...base, connectionString: form.connectionString.trim() };
      }

      if (form.dbType === 'supabase' && form.pgDbPassword.trim()) {
        setSetupStatus("running");
        try {
          const res = await fetch('/api/setup-tables', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ supabaseUrl: form.url.trim(), dbPassword: form.pgDbPassword.trim() }),
          });
          const data = await res.json() as { success?: boolean; tablesCreated?: string[]; errors?: { label: string; error: string }[] };
          if (data.success) {
            setSetupStatus("done");
            toast.success(`Database ready! ${data.tablesCreated?.length ?? 0} tables created.`);
          } else if (data.tablesCreated && data.tablesCreated.length > 0) {
            setSetupStatus("partial");
            toast.warning("Most tables created. Some steps had issues — check the setup guide below.");
          } else {
            setSetupStatus("failed");
            toast.error("Auto-setup failed. Please use the SQL guide below to set up tables manually.");
          }
        } catch {
          setSetupStatus("failed");
          toast.error("Could not run auto-setup. Please use the SQL guide below.");
        }
      }

      const saved = saveConnection(conn);
      setActiveConnection(saved.id);
      const didAutoSetup = form.dbType === 'supabase' && form.pgDbPassword.trim().length > 0;
      if (!didAutoSetup) {
        toast.success("Connected! Loading dashboard...");
      }
      setTimeout(() => { window.location.href = "/"; }, didAutoSetup ? 1400 : 700);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setSaving(false);
      setSetupStatus("idle");
    }
  };

  const handleActivate = (id: string) => {
    setActiveConnection(id);
    toast.success("Switching connection...");
    setTimeout(() => { window.location.href = "/"; }, 700);
  };

  const handleDelete = (id: string) => {
    deleteConnection(id);
    setDeleteConfirmId(null);
    reload();
    toast.success("Connection removed");
    setForm(emptyForm);
    setTestOk(null);
  };

  const inputCls = "w-full px-3.5 py-3 rounded-xl border border-border/60 bg-background/80 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all placeholder:text-muted-foreground/40";
  const labelCls = "block text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50/60 dark:from-zinc-950 dark:via-zinc-900 dark:to-blue-950/20 flex flex-col items-center justify-start py-10 px-4">

      {/* Decorative blobs */}
      <div className="fixed top-0 left-1/4 w-96 h-96 bg-blue-400/10 rounded-full blur-3xl pointer-events-none" />
      <div className="fixed bottom-0 right-1/4 w-80 h-80 bg-indigo-400/10 rounded-full blur-3xl pointer-events-none" />

      {/* Auto-setup progress overlay */}
      {setupStatus === "running" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 p-8 rounded-2xl bg-white/90 dark:bg-zinc-900/90 shadow-2xl border border-border/50 max-w-xs text-center">
            <Loader2 size={36} className="animate-spin text-blue-500" />
            <div>
              <p className="text-base font-bold text-foreground">Setting up your database…</p>
              <p className="text-xs text-muted-foreground mt-1">Creating tables and functions. This takes a few seconds.</p>
            </div>
          </div>
        </div>
      )}

      <div className="relative w-full max-w-[440px]">

        {/* Email verification notice */}
        {!noticeDismissed && (
          <div className="mb-5 rounded-2xl border border-amber-200/70 dark:border-amber-800/40 bg-amber-50/90 dark:bg-amber-950/30 backdrop-blur-xl shadow-lg shadow-amber-500/5 overflow-hidden">
            <div className="px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-lg bg-amber-500 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Zap size={13} className="text-white" />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-amber-800 dark:text-amber-300">Disable Email Confirmation for Instant Access</p>
                    <p className="text-[10.5px] text-amber-700/80 dark:text-amber-400/80 mt-1 leading-relaxed">
                      By default, Supabase requires email confirmation before login. Disable it so your first admin can sign up immediately:
                    </p>
                    <ol className="mt-2 space-y-0.5 text-[10.5px] text-amber-800 dark:text-amber-300 font-medium list-decimal list-inside leading-relaxed">
                      <li>Go to your Supabase Dashboard</li>
                      <li>Open <strong>Authentication → Providers → Email</strong></li>
                      <li>Turn off <strong>"Confirm email"</strong></li>
                      <li>Click <strong>Save</strong></li>
                    </ol>
                  </div>
                </div>
                <button
                  onClick={() => { setNoticeDismissed(true); localStorage.setItem(EMAIL_NOTICE_KEY, "1"); }}
                  className="flex-shrink-0 text-amber-500 hover:text-amber-700 dark:hover:text-amber-300 transition-colors p-1 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/40"
                  title="Dismiss"
                  data-testid="button-dismiss-notice"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Logo header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/30 mb-4">
            <Zap size={22} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Meta <span className="text-blue-500">Automation</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Connect your database to get started</p>
        </div>

        {/* Saved connections */}
        {connections.length > 0 && (
          <div className="mb-4 rounded-2xl border border-border/50 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-xl shadow-xl shadow-black/5 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-border/40">
              <div className="flex items-center gap-2">
                <Wifi size={13} className="text-muted-foreground" />
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Connections ({connections.length}/{MAX_CONNECTIONS})
                </span>
              </div>
              {connections.length < MAX_CONNECTIONS && (
                <button
                  onClick={() => { setShowForm(v => !v); setForm(emptyForm); setTestOk(null); }}
                  className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-600 font-semibold transition-colors"
                  data-testid="button-toggle-form"
                >
                  <Plus size={12} /> Add New
                </button>
              )}
            </div>
            <div className="p-3 space-y-2">
              {connections.map(conn => {
                const typeInfo = DB_TYPES.find(t => t.value === (conn.dbType || 'supabase'))!;
                const displayUrl = getConnectionDisplayUrl(conn);
                const isActive = conn.id === activeId;
                return (
                  <div
                    key={conn.id}
                    className={cn(
                      'group flex items-center gap-3 p-3.5 rounded-xl border transition-all cursor-default',
                      isActive
                        ? "bg-blue-50/80 dark:bg-blue-950/30 border-blue-200/60 dark:border-blue-800/40"
                        : "bg-muted/20 border-border/30 hover:bg-muted/40 hover:border-border/50"
                    )}
                    data-testid={`card-connection-${conn.id}`}
                  >
                    <div className={cn('w-2 h-2 rounded-full flex-shrink-0', isActive ? 'bg-emerald-500 shadow-sm shadow-emerald-500/50' : 'bg-muted-foreground/25')} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm">{typeInfo.icon}</span>
                        <p className="text-sm font-semibold truncate text-foreground">{conn.name}</p>
                      </div>
                      {displayUrl && (
                        <p className="text-[10px] text-muted-foreground truncate font-mono mt-0.5 opacity-70">{displayUrl}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {isActive ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400">
                          Active
                        </span>
                      ) : (
                        <button
                          onClick={() => handleActivate(conn.id)}
                          className="px-3 py-1 rounded-lg text-[11px] font-semibold bg-blue-500 text-white hover:bg-blue-600 transition-colors shadow-sm"
                          data-testid={`button-activate-${conn.id}`}
                        >
                          Use
                        </button>
                      )}
                      {deleteConfirmId === conn.id ? (
                        <div className="flex items-center gap-1">
                          <button onClick={() => handleDelete(conn.id)} className="px-2 py-1 rounded-lg text-[10px] font-bold bg-red-500 text-white hover:bg-red-600 transition-colors" data-testid={`button-delete-confirm-${conn.id}`}>Delete</button>
                          <button onClick={() => setDeleteConfirmId(null)} className="px-2 py-1 rounded-lg text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setDeleteConfirmId(conn.id)}
                          className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-red-50 dark:hover:bg-red-950/40 text-muted-foreground hover:text-red-500 transition-all"
                          title="Delete"
                          data-testid={`button-delete-connection-${conn.id}`}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Add connection form */}
        {showForm && (
          <div className="rounded-2xl border border-border/50 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-xl shadow-2xl shadow-black/10 overflow-hidden">

            {/* Card header */}
            <div className="px-6 py-5 border-b border-border/40 bg-gradient-to-r from-blue-50/60 to-indigo-50/40 dark:from-blue-950/20 dark:to-indigo-950/10">
              <h2 className="text-base font-bold text-foreground">New Database Connection</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Choose your database type and enter credentials</p>
            </div>

            <div className="p-6 space-y-5">
              {/* DB Type pills */}
              <div>
                <label className={labelCls}>Database Type</label>
                <div className="grid grid-cols-5 gap-1.5">
                  {DB_TYPES.map(t => (
                    <button
                      key={t.value}
                      onClick={() => { setField('dbType', t.value); setTestOk(null); }}
                      data-testid={`dbtype-${t.value}`}
                      className={cn(
                        "flex flex-col items-center gap-1.5 py-3 px-1 rounded-xl border-2 text-center transition-all select-none",
                        form.dbType === t.value
                          ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40 shadow-sm shadow-blue-500/10"
                          : "border-transparent bg-muted/30 hover:bg-muted/60 hover:border-border/60"
                      )}
                    >
                      <span className="text-xl leading-none">{t.icon}</span>
                      <span className={cn("text-[10px] font-bold leading-none", form.dbType === t.value ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground")}>{t.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Connection Name */}
              <div>
                <label className={labelCls}>Connection Name <span className="text-red-400">*</span></label>
                <input value={form.name} onChange={e => setField("name", e.target.value)} placeholder="My Store / Client A" className={inputCls} data-testid="input-connection-name" />
              </div>

              {/* Supabase fields */}
              {form.dbType === 'supabase' && (
                <div className="space-y-4 rounded-xl border border-border/50 bg-muted/20 p-4">
                  <div>
                    <label className={labelCls}>Project URL <span className="text-red-400">*</span></label>
                    <div className="relative">
                      <Link2 size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
                      <input value={form.url} onChange={e => setField("url", e.target.value)} placeholder="https://xxxxxxxxxxxx.supabase.co" className={cn(inputCls, "pl-9 font-mono placeholder:font-sans")} data-testid="input-supabase-url" />
                    </div>
                  </div>
                  <div>
                    <label className={labelCls}>Anon / Public Key <span className="text-red-400">*</span></label>
                    <input value={form.anonKey} onChange={e => setField("anonKey", e.target.value)} placeholder="eyJhbGciOiJIUzI1NiIs..." type="password" className={cn(inputCls, "font-mono placeholder:font-sans")} data-testid="input-anon-key" />
                  </div>
                  <div>
                    <button onClick={() => setShowServiceKey(v => !v)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="button-toggle-service-key">
                      <Key size={11} />
                      <span>Service Role Key</span>
                      <span className="text-muted-foreground/50">(optional — for webhooks)</span>
                      {showServiceKey ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                    </button>
                    {showServiceKey && (
                      <input value={form.serviceRoleKey} onChange={e => setField("serviceRoleKey", e.target.value)} placeholder="eyJhbGciOiJIUzI1NiIs..." type="password" className={cn(inputCls, "mt-2 font-mono placeholder:font-sans")} data-testid="input-service-role-key" />
                    )}
                  </div>

                  {/* Auto-setup: DB Password */}
                  <div className="rounded-xl bg-emerald-50/60 dark:bg-emerald-950/20 border border-emerald-200/50 dark:border-emerald-800/30 p-3.5">
                    <button onClick={() => setShowPgPassword(v => !v)} className="flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 transition-colors w-full text-left" data-testid="button-toggle-pg-password">
                      <Zap size={11} className="flex-shrink-0" />
                      <span>Auto-Setup Database</span>
                      <span className="text-emerald-600/60 dark:text-emerald-500/60 font-normal">(recommended for new clients)</span>
                      {showPgPassword ? <ChevronUp size={11} className="ml-auto" /> : <ChevronDown size={11} className="ml-auto" />}
                    </button>
                    {showPgPassword && (
                      <div className="mt-3 space-y-2">
                        <p className="text-[10.5px] text-emerald-700/80 dark:text-emerald-400/80 leading-relaxed">
                          Enter your <strong>Database Password</strong> (not the anon key) to automatically create all required tables.
                          Find it in <span className="font-semibold">Supabase → Project Settings → Database → Database password</span>.
                        </p>
                        <div className="relative">
                          <input
                            value={form.pgDbPassword}
                            onChange={e => setField("pgDbPassword", e.target.value)}
                            placeholder="••••••••••••••••"
                            type={showPassword ? 'text' : 'password'}
                            className={cn(inputCls, "pr-10 font-mono placeholder:font-sans border-emerald-300/50 dark:border-emerald-700/40 focus:ring-emerald-400/30 focus:border-emerald-500/50")}
                            data-testid="input-pg-db-password"
                          />
                          <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">{showPassword ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                        </div>
                        {form.pgDbPassword.trim() && (
                          <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1">
                            <CheckCircle2 size={10} /> Tables will be created automatically when you save
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* PostgreSQL / MySQL fields */}
              {(form.dbType === 'postgresql' || form.dbType === 'mysql') && (
                <div className="space-y-3 rounded-xl border border-border/50 bg-muted/20 p-4">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <label className={labelCls}>Host <span className="text-red-400">*</span></label>
                      <input value={form.host} onChange={e => setField("host", e.target.value)} placeholder={form.dbType === 'postgresql' ? 'db.example.com' : 'mysql.example.com'} className={inputCls} data-testid="input-host" />
                    </div>
                    <div>
                      <label className={labelCls}>Port</label>
                      <input value={form.port} onChange={e => setField("port", e.target.value)} placeholder={currentType.defaultPort} className={inputCls} data-testid="input-port" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls}>Username <span className="text-red-400">*</span></label>
                      <input value={form.dbUsername} onChange={e => setField("dbUsername", e.target.value)} placeholder={form.dbType === 'postgresql' ? 'postgres' : 'root'} className={inputCls} data-testid="input-username" />
                    </div>
                    <div>
                      <label className={labelCls}>Password</label>
                      <div className="relative">
                        <input value={form.dbPassword} onChange={e => setField("dbPassword", e.target.value)} placeholder="••••••••" type={showPassword ? 'text' : 'password'} className={cn(inputCls, "pr-10")} data-testid="input-password" />
                        <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">{showPassword ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                      </div>
                    </div>
                  </div>
                  <div>
                    <label className={labelCls}>Database Name</label>
                    <input value={form.dbName} onChange={e => setField("dbName", e.target.value)} placeholder="mydb" className={inputCls} data-testid="input-dbname" />
                  </div>
                </div>
              )}

              {/* MongoDB */}
              {form.dbType === 'mongodb' && (
                <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
                  <label className={labelCls}>MongoDB URI <span className="text-red-400">*</span></label>
                  <div className="relative">
                    <input value={form.connectionString} onChange={e => setField("connectionString", e.target.value)} placeholder="mongodb+srv://user:pass@cluster.mongodb.net/db" type={showPassword ? 'text' : 'password'} className={cn(inputCls, "pr-10 font-mono placeholder:font-sans")} data-testid="input-mongo-uri" />
                    <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">{showPassword ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                  </div>
                </div>
              )}

              {/* Redis */}
              {form.dbType === 'redis' && (
                <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
                  <label className={labelCls}>Redis Connection String <span className="text-red-400">*</span></label>
                  <div className="relative">
                    <input value={form.connectionString} onChange={e => setField("connectionString", e.target.value)} placeholder="redis://default:password@host:6379" type={showPassword ? 'text' : 'password'} className={cn(inputCls, "pr-10 font-mono placeholder:font-sans")} data-testid="input-redis-uri" />
                    <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">{showPassword ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                  </div>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-2.5 pt-1">
                <button
                  onClick={testConnection}
                  disabled={testing || saving || !canTest()}
                  className={cn(
                    "flex items-center justify-center gap-2 px-4 py-3 rounded-xl border text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed",
                    testOk === true
                      ? "border-emerald-400/50 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30"
                      : testOk === false
                        ? "border-red-400/50 text-red-500 bg-red-50 dark:bg-red-950/30"
                        : "border-border/60 text-muted-foreground bg-muted/30 hover:bg-muted/60 hover:text-foreground"
                  )}
                  data-testid="button-test-connection"
                >
                  {testing ? <Loader2 size={14} className="animate-spin" /> : testOk === true ? <CheckCircle2 size={14} /> : <Server size={14} />}
                  {testing ? "Testing..." : testOk === true ? "Verified" : "Test"}
                </button>

                <button
                  onClick={handleSave}
                  disabled={testing || saving || !canSave()}
                  className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white text-sm font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-blue-500/25"
                  data-testid="button-save-connection"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                  {saving
                    ? (setupStatus === "running" ? "Setting up tables…" : "Connecting...")
                    : (form.dbType === 'supabase' && form.pgDbPassword.trim() ? "Auto-Setup & Connect" : "Save & Connect")
                  }
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Help hint */}
        {form.dbType === 'supabase' && showForm && (
          <p className="mt-4 text-center text-[11px] text-muted-foreground/60 leading-relaxed">
            Find credentials in{" "}
            <span className="font-medium text-muted-foreground">Supabase Dashboard → Project Settings → API</span>
          </p>
        )}
      </div>

      {/* Setup Guide section */}
      <SetupGuideSection />

      <div className="h-10" />
    </div>
  );
};

export default ConnectDB;
