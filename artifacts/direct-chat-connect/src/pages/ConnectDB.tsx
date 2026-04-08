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
  Database,
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
} from "lucide-react";
import { cn } from "@/lib/utils";

const emptyForm = {
  name: "",
  dbType: "supabase" as MainDbType,
  // Supabase
  url: "",
  anonKey: "",
  serviceRoleKey: "",
  // PostgreSQL / MySQL
  host: "",
  port: "",
  dbUsername: "",
  dbPassword: "",
  dbName: "",
  // MongoDB / Redis
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
    if (!canTest()) {
      toast.error("Please fill in the required fields");
      return;
    }
    setTesting(true);
    setTestOk(null);
    try {
      if (form.dbType === 'supabase') {
        const client = createClient(form.url.trim(), form.anonKey.trim(), {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { error } = await client.auth.getSession();
        if (error && !error.message.toLowerCase().includes("refresh token")) {
          throw error;
        }
        setTestOk(true);
        toast.success("Supabase connection successful!");
      } else {
        // For non-Supabase types, we just validate the form without a live test
        // (browser can't connect directly — edge function handles it)
        setTestOk(true);
        toast.success("Settings valid! Will connect via edge function.");
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
    if (!form.name.trim()) { toast.error("Please enter a name for this connection"); return; }
    if (!canTest()) { toast.error("Please fill in the required fields"); return; }
    setSaving(true);
    try {
      const base = {
        name: form.name.trim(),
        dbType: form.dbType,
        // Provide defaults for all Supabase fields so the type is satisfied
        url: '',
        anonKey: '',
      };
      let conn: Omit<MainDbConnection, 'id' | 'createdAt'>;
      if (form.dbType === 'supabase') {
        conn = {
          ...base,
          url: form.url.trim(),
          anonKey: form.anonKey.trim(),
          serviceRoleKey: form.serviceRoleKey.trim() || undefined,
        };
      } else if (form.dbType === 'postgresql' || form.dbType === 'mysql') {
        conn = {
          ...base,
          host: form.host.trim(),
          port: form.port.trim() || currentType.defaultPort,
          dbUsername: form.dbUsername.trim(),
          dbPassword: form.dbPassword,
          dbName: form.dbName.trim(),
        };
      } else {
        conn = {
          ...base,
          connectionString: form.connectionString.trim(),
        };
      }
      const saved = saveConnection(conn);
      setActiveConnection(saved.id);
      toast.success("Saved! Loading dashboard...");
      setTimeout(() => { window.location.href = "/"; }, 700);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(msg);
      setSaving(false);
    }
  };

  const handleActivate = (id: string) => {
    setActiveConnection(id);
    toast.success("Switching...");
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex flex-col items-center justify-center p-4">

      {/* Branding */}
      <div className="mb-8 text-center select-none">
        <div className="inline-flex items-center gap-3 mb-2">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shadow-lg shadow-primary/20">
            <Zap size={20} className="text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">
            Meta <span className="text-primary">Automation</span>
          </h1>
        </div>
        <p className="text-muted-foreground text-sm">
          Connect your database
        </p>
      </div>

      {/* Saved connections */}
      {connections.length > 0 && (
        <div className="w-full max-w-md mb-4">
          <div className="backdrop-blur-xl bg-card/80 border border-border/50 rounded-2xl p-5 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Saved Connections ({connections.length}/{MAX_CONNECTIONS})
              </span>
              {connections.length < MAX_CONNECTIONS && (
                <button
                  onClick={() => { setShowForm(v => !v); setForm(emptyForm); setTestOk(null); }}
                  className="flex items-center gap-1 text-[11px] text-primary hover:text-primary/80 font-medium transition-colors"
                  data-testid="button-toggle-form"
                >
                  <Plus size={11} /> Add New
                </button>
              )}
            </div>
            <div className="space-y-2">
              {connections.map(conn => {
                const typeInfo = DB_TYPES.find(t => t.value === (conn.dbType || 'supabase'))!;
                const displayUrl = getConnectionDisplayUrl(conn);
                return (
                  <div
                    key={conn.id}
                    className={cn(
                      'flex items-center gap-3 p-3 rounded-xl border transition-all',
                      conn.id === activeId
                        ? "bg-primary/8 border-primary/25"
                        : "bg-muted/20 border-border/20 hover:bg-muted/40"
                    )}
                    data-testid={`card-connection-${conn.id}`}
                  >
                    <div className={cn('w-2 h-2 rounded-full flex-shrink-0', conn.id === activeId ? 'bg-green-500' : 'bg-muted-foreground/25')} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm leading-none">{typeInfo.icon}</span>
                        <p className="text-sm font-medium truncate">{conn.name}</p>
                      </div>
                      {displayUrl && (
                        <p className="text-[10px] text-muted-foreground truncate font-mono mt-0.5">{displayUrl}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {conn.id === activeId ? (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-green-500/15 text-green-600 dark:text-green-400">
                          Active
                        </span>
                      ) : (
                        <button
                          onClick={() => handleActivate(conn.id)}
                          className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                          data-testid={`button-activate-${conn.id}`}
                        >
                          Use
                        </button>
                      )}
                      {deleteConfirmId === conn.id ? (
                        <div className="flex items-center gap-1 ml-0.5">
                          <button
                            onClick={() => handleDelete(conn.id)}
                            className="px-2 py-1 rounded-lg text-[10px] font-semibold bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
                            data-testid={`button-delete-confirm-${conn.id}`}
                          >Delete</button>
                          <button
                            onClick={() => setDeleteConfirmId(null)}
                            className="px-2 py-1 rounded-lg text-[10px] font-medium bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          >Cancel</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setDeleteConfirmId(conn.id)}
                          className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors ml-0.5"
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
        </div>
      )}

      {/* Add form */}
      {showForm && (
        <div className="w-full max-w-md backdrop-blur-xl bg-card/80 border border-border/50 rounded-2xl p-6 shadow-xl space-y-5">
          <h2 className="font-semibold flex items-center gap-2 text-sm">
            <Database size={15} className="text-primary" />
            New Database Connection
          </h2>

          {/* DB Type Selector */}
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Database Type
            </p>
            <div className="grid grid-cols-5 gap-1.5">
              {DB_TYPES.map(t => (
                <button
                  key={t.value}
                  onClick={() => { setField('dbType', t.value); setTestOk(null); }}
                  data-testid={`dbtype-${t.value}`}
                  className={cn(
                    "flex flex-col items-center gap-1 py-2.5 px-1 rounded-xl border text-center transition-all",
                    form.dbType === t.value
                      ? "border-primary bg-primary/10 shadow-sm"
                      : "border-border hover:border-primary/30 hover:bg-muted/40"
                  )}
                >
                  <span className="text-lg leading-none">{t.icon}</span>
                  <span className={cn("text-[10px] font-semibold leading-none",
                    form.dbType === t.value ? "text-primary" : "text-muted-foreground"
                  )}>{t.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Connection Name */}
          <div>
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Connection Name <span className="text-destructive">*</span>
            </label>
            <input
              value={form.name}
              onChange={e => setField("name", e.target.value)}
              placeholder="My Store / Client A"
              className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-border/50 bg-background/60 text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-all placeholder:text-muted-foreground/50"
              data-testid="input-connection-name"
            />
          </div>

          {/* ── Supabase fields ── */}
          {form.dbType === 'supabase' && (
            <div className="space-y-4 bg-muted/30 rounded-xl p-4 border border-border/40">
              <div>
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Supabase Project URL <span className="text-destructive">*</span>
                </label>
                <div className="relative mt-1.5">
                  <Link2 size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
                  <input
                    value={form.url}
                    onChange={e => setField("url", e.target.value)}
                    placeholder="https://xxxxxxxxxxxx.supabase.co"
                    className="w-full pl-8 pr-3 py-2.5 rounded-xl border border-border/50 bg-background/60 text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-all font-mono placeholder:font-sans placeholder:text-muted-foreground/50"
                    data-testid="input-supabase-url"
                  />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Anon / Public Key <span className="text-destructive">*</span>
                </label>
                <input
                  value={form.anonKey}
                  onChange={e => setField("anonKey", e.target.value)}
                  placeholder="eyJhbGciOiJIUzI1NiIs..."
                  type="password"
                  className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-border/50 bg-background/60 text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-all font-mono placeholder:font-sans placeholder:text-muted-foreground/50"
                  data-testid="input-anon-key"
                />
              </div>
              <div>
                <button
                  onClick={() => setShowServiceKey(v => !v)}
                  className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                  data-testid="button-toggle-service-key"
                >
                  <Key size={11} />
                  Service Role Key (optional — for webhooks)
                  {showServiceKey ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                </button>
                {showServiceKey && (
                  <input
                    value={form.serviceRoleKey}
                    onChange={e => setField("serviceRoleKey", e.target.value)}
                    placeholder="eyJhbGciOiJIUzI1NiIs..."
                    type="password"
                    className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-border/50 bg-background/60 text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-all font-mono placeholder:font-sans placeholder:text-muted-foreground/50"
                    data-testid="input-service-role-key"
                  />
                )}
              </div>
            </div>
          )}

          {/* ── PostgreSQL / MySQL fields ── */}
          {(form.dbType === 'postgresql' || form.dbType === 'mysql') && (
            <div className="space-y-3 bg-muted/30 rounded-xl p-4 border border-border/40">
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Host <span className="text-destructive">*</span>
                  </label>
                  <input
                    value={form.host}
                    onChange={e => setField("host", e.target.value)}
                    placeholder={form.dbType === 'postgresql' ? 'db.example.com' : 'mysql.example.com'}
                    className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-border/50 bg-background/60 text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-all placeholder:text-muted-foreground/50"
                    data-testid="input-host"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Port</label>
                  <input
                    value={form.port}
                    onChange={e => setField("port", e.target.value)}
                    placeholder={currentType.defaultPort}
                    className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-border/50 bg-background/60 text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-all placeholder:text-muted-foreground/50"
                    data-testid="input-port"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Username <span className="text-destructive">*</span>
                  </label>
                  <input
                    value={form.dbUsername}
                    onChange={e => setField("dbUsername", e.target.value)}
                    placeholder={form.dbType === 'postgresql' ? 'postgres' : 'root'}
                    className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-border/50 bg-background/60 text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-all placeholder:text-muted-foreground/50"
                    data-testid="input-username"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Password</label>
                  <div className="relative mt-1.5">
                    <input
                      value={form.dbPassword}
                      onChange={e => setField("dbPassword", e.target.value)}
                      placeholder="••••••••"
                      type={showPassword ? 'text' : 'password'}
                      className="w-full px-3 pr-9 py-2.5 rounded-xl border border-border/50 bg-background/60 text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-all"
                      data-testid="input-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(v => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                </div>
              </div>
              <div>
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Database Name</label>
                <input
                  value={form.dbName}
                  onChange={e => setField("dbName", e.target.value)}
                  placeholder="mydb"
                  className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-border/50 bg-background/60 text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-all placeholder:text-muted-foreground/50"
                  data-testid="input-dbname"
                />
              </div>
              <p className="text-[10px] text-muted-foreground">
                {form.dbType === 'postgresql' ? 'Neon, Supabase, Railway, Render, etc.' : 'PlanetScale, Railway, DigitalOcean, etc.'}
              </p>
            </div>
          )}

          {/* ── MongoDB ── */}
          {form.dbType === 'mongodb' && (
            <div className="space-y-3 bg-muted/30 rounded-xl p-4 border border-border/40">
              <div>
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  MongoDB URI <span className="text-destructive">*</span>
                </label>
                <div className="relative mt-1.5">
                  <input
                    value={form.connectionString}
                    onChange={e => setField("connectionString", e.target.value)}
                    placeholder="mongodb+srv://user:pass@cluster.mongodb.net/db"
                    type={showPassword ? 'text' : 'password'}
                    className="w-full px-3 pr-9 py-2.5 rounded-xl border border-border/50 bg-background/60 text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-all font-mono placeholder:font-sans placeholder:text-muted-foreground/50"
                    data-testid="input-mongo-uri"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">MongoDB Atlas or local MongoDB URI</p>
              </div>
            </div>
          )}

          {/* ── Redis ── */}
          {form.dbType === 'redis' && (
            <div className="space-y-3 bg-muted/30 rounded-xl p-4 border border-border/40">
              <div>
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Redis Connection String <span className="text-destructive">*</span>
                </label>
                <div className="relative mt-1.5">
                  <input
                    value={form.connectionString}
                    onChange={e => setField("connectionString", e.target.value)}
                    placeholder="redis://:password@host:6379"
                    type={showPassword ? 'text' : 'password'}
                    className="w-full px-3 pr-9 py-2.5 rounded-xl border border-border/50 bg-background/60 text-sm focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-all font-mono placeholder:font-sans placeholder:text-muted-foreground/50"
                    data-testid="input-redis-uri"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">Upstash, Redis Cloud, etc.</p>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={testConnection}
              disabled={testing || saving || !canTest()}
              className={cn(
                "flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border text-sm font-medium transition-all disabled:opacity-50",
                testOk === true
                  ? "border-green-500/40 text-green-600 bg-green-500/10"
                  : testOk === false
                    ? "border-destructive/40 text-destructive bg-destructive/10"
                    : "border-border/50 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              )}
              data-testid="button-test-connection"
            >
              {testing
                ? <Loader2 size={13} className="animate-spin" />
                : testOk === true
                  ? <CheckCircle2 size={13} />
                  : <Server size={13} />
              }
              {testing ? "Testing..." : "Test"}
            </button>
            <button
              onClick={handleSave}
              disabled={testing || saving || !canSave()}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all disabled:opacity-50 shadow-md shadow-primary/20"
              data-testid="button-save-connection"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <ArrowRight size={13} />}
              {saving ? "Saving..." : "Save & Connect"}
            </button>
          </div>

          {/* Supported DBs note */}
          <div className="rounded-xl border border-border/40 bg-muted/20 p-3 text-[10px] text-muted-foreground space-y-0.5">
            <p className="font-semibold text-[11px] text-foreground/70 mb-1.5 flex items-center gap-1"><Server size={10} /> Supported Databases</p>
            <p>⚡ <strong>Supabase</strong> — URL + Anon Key</p>
            <p>🐘 <strong>PostgreSQL</strong> — Host / Port / User / Password</p>
            <p>🐬 <strong>MySQL</strong> — Host / Port / User / Password</p>
            <p>🍃 <strong>MongoDB</strong> — mongodb+srv:// URI</p>
            <p>🔴 <strong>Redis</strong> — redis:// URI</p>
          </div>
        </div>
      )}

      {/* Help */}
      {form.dbType === 'supabase' && (
        <p className="mt-6 text-[11px] text-muted-foreground/60 text-center max-w-xs leading-relaxed">
          Supabase Dashboard → Project Settings → API → Project URL & anon key
        </p>
      )}
    </div>
  );
};

export default ConnectDB;
