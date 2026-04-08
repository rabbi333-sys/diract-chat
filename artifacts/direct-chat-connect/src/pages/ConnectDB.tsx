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
} from "lucide-react";
import { cn } from "@/lib/utils";

const emptyForm = {
  name: "",
  dbType: "supabase" as MainDbType,
  url: "",
  anonKey: "",
  serviceRoleKey: "",
  host: "",
  port: "",
  dbUsername: "",
  dbPassword: "",
  dbName: "",
  connectionString: "",
};

type FormState = typeof emptyForm;

const ConnectDB = () => {
  const [connections, setConnections] = useState<MainDbConnection[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showServiceKey, setShowServiceKey] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

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
      const saved = saveConnection(conn);
      setActiveConnection(saved.id);
      toast.success("Connected! Loading dashboard...");
      setTimeout(() => { window.location.href = "/"; }, 700);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setSaving(false);
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
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50/60 dark:from-zinc-950 dark:via-zinc-900 dark:to-blue-950/20 flex items-center justify-center p-4">

      {/* Decorative blobs */}
      <div className="fixed top-0 left-1/4 w-96 h-96 bg-blue-400/10 rounded-full blur-3xl pointer-events-none" />
      <div className="fixed bottom-0 right-1/4 w-80 h-80 bg-indigo-400/10 rounded-full blur-3xl pointer-events-none" />

      <div className="relative w-full max-w-[440px]">

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
                    <div className={cn(
                      'w-2 h-2 rounded-full flex-shrink-0 transition-colors',
                      isActive ? 'bg-emerald-500 shadow-sm shadow-emerald-500/50' : 'bg-muted-foreground/25'
                    )} />
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
                          <button
                            onClick={() => handleDelete(conn.id)}
                            className="px-2 py-1 rounded-lg text-[10px] font-bold bg-red-500 text-white hover:bg-red-600 transition-colors"
                            data-testid={`button-delete-confirm-${conn.id}`}
                          >Delete</button>
                          <button
                            onClick={() => setDeleteConfirmId(null)}
                            className="px-2 py-1 rounded-lg text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                          >Cancel</button>
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

        {/* Add form — modal card */}
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
                      <span className={cn(
                        "text-[10px] font-bold leading-none",
                        form.dbType === t.value ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground"
                      )}>{t.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Connection Name */}
              <div>
                <label className={labelCls}>
                  Connection Name <span className="text-red-400">*</span>
                </label>
                <input
                  value={form.name}
                  onChange={e => setField("name", e.target.value)}
                  placeholder="My Store / Client A"
                  className={inputCls}
                  data-testid="input-connection-name"
                />
              </div>

              {/* ── Supabase fields ── */}
              {form.dbType === 'supabase' && (
                <div className="space-y-4 rounded-xl border border-border/50 bg-muted/20 p-4">
                  <div>
                    <label className={labelCls}>
                      Project URL <span className="text-red-400">*</span>
                    </label>
                    <div className="relative">
                      <Link2 size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
                      <input
                        value={form.url}
                        onChange={e => setField("url", e.target.value)}
                        placeholder="https://xxxxxxxxxxxx.supabase.co"
                        className={cn(inputCls, "pl-9 font-mono placeholder:font-sans")}
                        data-testid="input-supabase-url"
                      />
                    </div>
                  </div>
                  <div>
                    <label className={labelCls}>
                      Anon / Public Key <span className="text-red-400">*</span>
                    </label>
                    <input
                      value={form.anonKey}
                      onChange={e => setField("anonKey", e.target.value)}
                      placeholder="eyJhbGciOiJIUzI1NiIs..."
                      type="password"
                      className={cn(inputCls, "font-mono placeholder:font-sans")}
                      data-testid="input-anon-key"
                    />
                  </div>
                  <div>
                    <button
                      onClick={() => setShowServiceKey(v => !v)}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      data-testid="button-toggle-service-key"
                    >
                      <Key size={11} />
                      <span>Service Role Key</span>
                      <span className="text-muted-foreground/50">(optional — for webhooks)</span>
                      {showServiceKey ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                    </button>
                    {showServiceKey && (
                      <input
                        value={form.serviceRoleKey}
                        onChange={e => setField("serviceRoleKey", e.target.value)}
                        placeholder="eyJhbGciOiJIUzI1NiIs..."
                        type="password"
                        className={cn(inputCls, "mt-2 font-mono placeholder:font-sans")}
                        data-testid="input-service-role-key"
                      />
                    )}
                  </div>
                </div>
              )}

              {/* ── PostgreSQL / MySQL ── */}
              {(form.dbType === 'postgresql' || form.dbType === 'mysql') && (
                <div className="space-y-3 rounded-xl border border-border/50 bg-muted/20 p-4">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <label className={labelCls}>Host <span className="text-red-400">*</span></label>
                      <input
                        value={form.host}
                        onChange={e => setField("host", e.target.value)}
                        placeholder={form.dbType === 'postgresql' ? 'db.example.com' : 'mysql.example.com'}
                        className={inputCls}
                        data-testid="input-host"
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Port</label>
                      <input
                        value={form.port}
                        onChange={e => setField("port", e.target.value)}
                        placeholder={currentType.defaultPort}
                        className={inputCls}
                        data-testid="input-port"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls}>Username <span className="text-red-400">*</span></label>
                      <input
                        value={form.dbUsername}
                        onChange={e => setField("dbUsername", e.target.value)}
                        placeholder={form.dbType === 'postgresql' ? 'postgres' : 'root'}
                        className={inputCls}
                        data-testid="input-username"
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Password</label>
                      <div className="relative">
                        <input
                          value={form.dbPassword}
                          onChange={e => setField("dbPassword", e.target.value)}
                          placeholder="••••••••"
                          type={showPassword ? 'text' : 'password'}
                          className={cn(inputCls, "pr-10")}
                          data-testid="input-password"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(v => !v)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div>
                    <label className={labelCls}>Database Name</label>
                    <input
                      value={form.dbName}
                      onChange={e => setField("dbName", e.target.value)}
                      placeholder="mydb"
                      className={inputCls}
                      data-testid="input-dbname"
                    />
                  </div>
                </div>
              )}

              {/* ── MongoDB ── */}
              {form.dbType === 'mongodb' && (
                <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
                  <label className={labelCls}>MongoDB URI <span className="text-red-400">*</span></label>
                  <div className="relative">
                    <input
                      value={form.connectionString}
                      onChange={e => setField("connectionString", e.target.value)}
                      placeholder="mongodb+srv://user:pass@cluster.mongodb.net/db"
                      type={showPassword ? 'text' : 'password'}
                      className={cn(inputCls, "pr-10 font-mono placeholder:font-sans")}
                      data-testid="input-mongo-uri"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              )}

              {/* ── Redis ── */}
              {form.dbType === 'redis' && (
                <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
                  <label className={labelCls}>Redis Connection String <span className="text-red-400">*</span></label>
                  <div className="relative">
                    <input
                      value={form.connectionString}
                      onChange={e => setField("connectionString", e.target.value)}
                      placeholder="redis://default:password@host:6379"
                      type={showPassword ? 'text' : 'password'}
                      className={cn(inputCls, "pr-10 font-mono placeholder:font-sans")}
                      data-testid="input-redis-uri"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
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
                  {testing
                    ? <Loader2 size={14} className="animate-spin" />
                    : testOk === true
                      ? <CheckCircle2 size={14} />
                      : <Server size={14} />
                  }
                  {testing ? "Testing..." : testOk === true ? "Verified" : "Test"}
                </button>

                <button
                  onClick={handleSave}
                  disabled={testing || saving || !canSave()}
                  className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white text-sm font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-blue-500/25"
                  data-testid="button-save-connection"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                  {saving ? "Connecting..." : "Save & Connect"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Help hint for Supabase */}
        {form.dbType === 'supabase' && showForm && (
          <p className="mt-4 text-center text-[11px] text-muted-foreground/60 leading-relaxed">
            Find your credentials in{" "}
            <span className="font-medium text-muted-foreground">Supabase Dashboard → Project Settings → API</span>
          </p>
        )}
      </div>
    </div>
  );
};

export default ConnectDB;
