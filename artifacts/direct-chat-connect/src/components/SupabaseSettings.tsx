import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { validateConnection } from '@/lib/externalDb';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Database, Check, Loader2, Eye, EyeOff, Trash2, RefreshCw,
  Server, CheckCircle2, WifiOff, AlertTriangle
} from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';

type DbType = 'supabase' | 'postgresql' | 'mysql' | 'mongodb' | 'redis';

interface StoredConnection {
  db_type: DbType;
  // Supabase
  supabase_url: string;
  service_role_key: string;
  // PostgreSQL / MySQL — individual fields
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  // MongoDB / Redis — full URI string
  connection_string: string;
  // Common
  table_name: string;
  is_active: boolean;
}

const STORAGE_KEY = 'chat_monitor_db_settings';

const emptyConn = (dbType: DbType = 'supabase'): StoredConnection => ({
  db_type: dbType,
  supabase_url: '', service_role_key: '',
  host: '', port: '', username: '', password: '', database: '',
  connection_string: '',
  table_name: 'n8n_chat_histories',
  is_active: true,
});

const loadFromStorage = (): StoredConnection | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as StoredConnection;
  } catch {}
  return null;
};

const saveToStorage = (s: StoredConnection) => localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
const clearStorage = () => localStorage.removeItem(STORAGE_KEY);

const DB_TYPES: { value: DbType; icon: string; label: string; defaultPort: string }[] = [
  { value: 'supabase',    icon: '⚡', label: 'Supabase',    defaultPort: '' },
  { value: 'postgresql',  icon: '🐘', label: 'PostgreSQL',  defaultPort: '5432' },
  { value: 'mysql',       icon: '🐬', label: 'MySQL',       defaultPort: '3306' },
  { value: 'mongodb',     icon: '🍃', label: 'MongoDB',     defaultPort: '27017' },
  { value: 'redis',       icon: '🔴', label: 'Redis',       defaultPort: '6379' },
];

type ValidationState = 'idle' | 'loading' | 'ok' | 'fail' | 'table-missing';

export const SupabaseSettings = () => {
  const queryClient = useQueryClient();
  const saved = loadFromStorage();
  // Merge saved data with emptyConn defaults to handle old localStorage format missing new fields
  const [form, setForm] = useState<StoredConnection>(
    saved ? { ...emptyConn(saved.db_type ?? 'supabase'), ...saved } : emptyConn()
  );
  const [showPassword, setShowPassword] = useState(false);
  const [validation, setValidation] = useState<ValidationState>('idle');
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof StoredConnection>(k: K, v: StoredConnection[K]) => {
    setForm((prev) => ({ ...prev, [k]: v }));
    if (k === 'table_name') setValidation('idle');
  };

  const hasSaved = !!saved;
  const currentType = DB_TYPES.find((t) => t.value === form.db_type)!;

  const canSave = (() => {
    if (form.db_type === 'supabase') return form.supabase_url.trim() !== '' && form.service_role_key.trim() !== '';
    if (form.db_type === 'postgresql' || form.db_type === 'mysql') return form.host.trim() !== '' && form.username.trim() !== '';
    return form.connection_string.trim() !== '';
  })();

  const doValidate = async (): Promise<ValidationState> => {
    const conn = loadFromStorage();
    if (!conn) return 'fail';
    // validateConnection goes directly to Supabase (no edge function needed)
    return await validateConnection(conn) as ValidationState;
  };

  const handleSave = async () => {
    setSaving(true);
    setValidation('idle');
    try {
      saveToStorage(form);
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['chat-history'] });
      toast.success('Settings saved! Checking connection...');
      setValidation('loading');
      const result = await doValidate();
      setValidation(result);
      if (result === 'ok') toast.success('Table found — check the Messages tab for data.');
      else if (result === 'table-missing') toast.error('Table name not found. Please check the name.');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setValidation('loading');
    const result = await doValidate();
    setValidation(result);
    if (result === 'ok') toast.success('Connection successful!');
    else if (result === 'table-missing') toast.error('Table not found.');
    else toast.error('Connection failed.');
  };

  const handleDelete = () => {
    clearStorage();
    setForm(emptyConn());
    setValidation('idle');
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
    toast.success('Settings cleared.');
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Database size={20} className="text-primary" />
        </div>
        <div>
          <h3 className="font-semibold text-foreground text-sm">Database Connection</h3>
          <p className="text-[11px] text-muted-foreground">Connect your n8n database to view chats in Messages</p>
        </div>
      </div>

      {/* DB Type selector */}
      <div>
        <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 block">
          Database Type
        </Label>
        <div className="grid grid-cols-5 gap-1.5">
          {DB_TYPES.map((t) => (
            <button
              key={t.value}
              onClick={() => { set('db_type', t.value); setValidation('idle'); }}
              data-testid={`dbtype-${t.value}`}
              className={cn(
                "flex flex-col items-center gap-1 py-2.5 px-1 rounded-xl border text-center transition-all",
                form.db_type === t.value
                  ? "border-primary bg-primary/10 shadow-sm"
                  : "border-border hover:border-primary/30 hover:bg-muted/40"
              )}
            >
              <span className="text-lg leading-none">{t.icon}</span>
              <span className={cn("text-[10px] font-semibold leading-none",
                form.db_type === t.value ? "text-primary" : "text-muted-foreground"
              )}>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Supabase fields ── */}
      {form.db_type === 'supabase' && (
        <div className="space-y-3 bg-muted/30 rounded-xl p-4 border border-border">
          <div className="space-y-1.5">
            <Label className="text-xs">Supabase Project URL</Label>
            <Input
              placeholder="https://xxxx.supabase.co"
              value={form.supabase_url}
              onChange={(e) => set('supabase_url', e.target.value)}
              data-testid="input-supabase-url"
              className="text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Service Role Key</Label>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                placeholder="eyJhbGciOiJIUzI1NiIs..."
                value={form.service_role_key}
                onChange={(e) => set('service_role_key', e.target.value)}
                className="pr-9 text-sm font-mono"
                data-testid="input-service-role-key"
              />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground">Supabase Dashboard → Settings → API → Service Role</p>
          </div>
        </div>
      )}

      {/* ── PostgreSQL / MySQL individual fields ── */}
      {(form.db_type === 'postgresql' || form.db_type === 'mysql') && (
        <div className="space-y-3 bg-muted/30 rounded-xl p-4 border border-border">
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs">Host</Label>
              <Input
                placeholder={form.db_type === 'postgresql' ? 'db.example.com' : 'mysql.example.com'}
                value={form.host}
                onChange={(e) => set('host', e.target.value)}
                data-testid="input-host"
                className="text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Port</Label>
              <Input
                placeholder={currentType.defaultPort}
                value={form.port}
                onChange={(e) => set('port', e.target.value)}
                data-testid="input-port"
                className="text-sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Username</Label>
              <Input
                placeholder={form.db_type === 'postgresql' ? 'postgres' : 'root'}
                value={form.username}
                onChange={(e) => set('username', e.target.value)}
                data-testid="input-username"
                className="text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Password</Label>
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={form.password}
                  onChange={(e) => set('password', e.target.value)}
                  className="pr-9 text-sm"
                  data-testid="input-password"
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Database Name</Label>
            <Input
              placeholder="mydb"
              value={form.database}
              onChange={(e) => set('database', e.target.value)}
              data-testid="input-database"
              className="text-sm"
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            {form.db_type === 'postgresql' ? 'Neon, Supabase, Railway, Render, etc.' : 'PlanetScale, Railway, DigitalOcean, etc.'}
          </p>
        </div>
      )}

      {/* ── MongoDB URI ── */}
      {form.db_type === 'mongodb' && (
        <div className="space-y-3 bg-muted/30 rounded-xl p-4 border border-border">
          <div className="space-y-1.5">
            <Label className="text-xs">MongoDB URI</Label>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                placeholder="mongodb+srv://user:pass@cluster.mongodb.net/db"
                value={form.connection_string}
                onChange={(e) => set('connection_string', e.target.value)}
                className="pr-9 text-sm font-mono"
                data-testid="input-mongo-uri"
              />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground">MongoDB Atlas or local MongoDB URI</p>
          </div>
        </div>
      )}

      {/* ── Redis URI ── */}
      {form.db_type === 'redis' && (
        <div className="space-y-3 bg-muted/30 rounded-xl p-4 border border-border">
          <div className="space-y-1.5">
            <Label className="text-xs">Redis Connection String</Label>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                placeholder="redis://:password@host:6379"
                value={form.connection_string}
                onChange={(e) => set('connection_string', e.target.value)}
                className="pr-9 text-sm font-mono"
                data-testid="input-redis-uri"
              />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground">Upstash, Redis Cloud, etc.</p>
          </div>
        </div>
      )}

      {/* ── Table Name (all types) ── */}
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold">
          {form.db_type === 'mongodb' ? 'Collection Name' : form.db_type === 'redis' ? 'Key Prefix' : 'Table Name'}
        </Label>
        <Input
          placeholder={form.db_type === 'redis' ? 'chat' : 'n8n_chat_histories'}
          value={form.table_name}
          onChange={(e) => set('table_name', e.target.value)}
          data-testid="input-table-name"
          className="text-sm"
        />
        <p className="text-[10px] text-muted-foreground">
          The n8n chat history {form.db_type === 'mongodb' ? 'collection' : form.db_type === 'redis' ? 'key prefix' : 'table'} name
          — usually <code className="bg-muted px-1 rounded">n8n_chat_histories</code>
        </p>
      </div>

      {/* Active toggle */}
      <div className="flex items-center justify-between bg-muted/20 rounded-xl px-4 py-3 border border-border">
        <div>
          <p className="text-sm font-medium">Enable Connection</p>
          <p className="text-[11px] text-muted-foreground">When enabled, data appears in the Messages tab</p>
        </div>
        <Switch checked={form.is_active} onCheckedChange={(v) => set('is_active', v)} data-testid="switch-active" />
      </div>

      {/* Validation Messages */}
      {validation === 'table-missing' && (
        <div className="flex items-start gap-2.5 p-3.5 rounded-xl border border-amber-500/40 bg-amber-500/10">
          <AlertTriangle size={15} className="mt-0.5 flex-shrink-0 text-amber-600" />
          <div className="text-xs">
            <p className="font-semibold text-amber-700 dark:text-amber-400">Table not found</p>
            <p className="mt-0.5 text-amber-600 dark:text-amber-500">
              The specified table was not found in the database. Please verify the table name.
            </p>
            <p className="mt-1 text-[10px] text-amber-600/70">
              Table: <code className="bg-amber-500/20 px-1 rounded">{form.table_name}</code>
            </p>
          </div>
        </div>
      )}
      {validation === 'ok' && (
        <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 size={14} /> Connection successful — table found
        </div>
      )}
      {validation === 'fail' && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <WifiOff size={14} /> Connection failed — please check your credentials
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          onClick={handleSave}
          disabled={!canSave || saving}
          size="sm"
          data-testid="button-save-connection"
        >
          {saving
            ? <Loader2 size={14} className="animate-spin mr-1.5" />
            : <Check size={14} className="mr-1.5" />}
          {hasSaved ? 'Update' : 'Save Connection'}
        </Button>

        {hasSaved && (
          <>
            <Button
              variant="outline" size="sm"
              onClick={handleTest}
              disabled={validation === 'loading'}
              data-testid="button-test-connection"
            >
              {validation === 'loading'
                ? <Loader2 size={14} className="animate-spin mr-1.5" />
                : <RefreshCw size={14} className="mr-1.5" />}
              Test
            </Button>
            <Button
              variant="ghost" size="icon"
              onClick={handleDelete}
              className="h-8 w-8 text-destructive hover:bg-destructive/10"
              data-testid="button-delete-connection"
            >
              <Trash2 size={14} />
            </Button>
          </>
        )}
      </div>

      {/* Current status */}
      {hasSaved && validation === 'idle' && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className={cn("w-2 h-2 rounded-full", form.is_active ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground")} />
          {DB_TYPES.find((t) => t.value === form.db_type)?.icon}{' '}
          {form.db_type.toUpperCase()} →{' '}
          <code className="bg-muted px-1 rounded">{form.table_name}</code>
          {form.db_type === 'postgresql' || form.db_type === 'mysql' ? ` @ ${form.host}` : ''}
        </div>
      )}

      {/* Info */}
      <div className="rounded-xl border border-border bg-muted/20 p-3.5">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          <Server size={11} /> Supported Databases
        </div>
        <div className="space-y-1 text-[11px] text-muted-foreground">
          <p>⚡ <strong>Supabase</strong> — URL + Service Role Key</p>
          <p>🐘 <strong>PostgreSQL</strong> — Host / Port / User / Password / Database</p>
          <p>🐬 <strong>MySQL</strong> — Host / Port / User / Password / Database</p>
          <p>🍃 <strong>MongoDB</strong> — mongodb+srv:// URI</p>
          <p>🔴 <strong>Redis</strong> — redis:// URI</p>
        </div>
        <p className="text-[10px] text-muted-foreground/60 mt-2 border-t border-border pt-2">
          Settings are stored locally in the browser — no additional tables required.
        </p>
      </div>
    </div>
  );
};
