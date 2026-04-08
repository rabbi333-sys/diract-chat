import { useState } from 'react';
import { ClipboardCopy, ChevronDown, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { MainDbType, DB_TYPES } from '@/lib/db-config';
import { AI_CONTROL_SQL } from '@/hooks/useAiControl';

/* ── Reusable copy-block ───────────────────────────────────────── */
const CopyBlock = ({ code, lang = 'sql' }: { code: string; lang?: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); toast.success('Copied!'); }
    catch { /* ignore */ }
  };
  return (
    <div className="relative rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden">
      <div className="absolute top-2 left-3 text-[9px] font-semibold uppercase tracking-widest text-zinc-600">{lang}</div>
      <pre className="text-[10px] font-mono text-zinc-400 px-3 pt-6 pb-3 overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-52">{code}</pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2.5 flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-semibold transition-colors"
      >
        <ClipboardCopy size={9} /> {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
};

/* ── Per-DB SQL setups ─────────────────────────────────────────── */
const MYSQL_SQL = `CREATE TABLE IF NOT EXISTS ai_control (
  session_id  VARCHAR(255) PRIMARY KEY,
  ai_enabled  TINYINT(1)   NOT NULL DEFAULT 1,
  user_id     VARCHAR(255),
  updated_at  DATETIME     DEFAULT CURRENT_TIMESTAMP
                           ON UPDATE CURRENT_TIMESTAMP
);`;

const POSTGRESQL_SQL = `CREATE TABLE IF NOT EXISTS ai_control (
  session_id  TEXT        PRIMARY KEY,
  ai_enabled  BOOLEAN     NOT NULL DEFAULT TRUE,
  user_id     TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;

const MONGODB_SETUP = `// Run in MongoDB Shell (mongosh)
db.createCollection("ai_control")
db.ai_control.createIndex({ session_id: 1 }, { unique: true })

// Default document (AI ON for a session):
db.ai_control.insertOne({
  session_id: "YOUR_SESSION_ID",
  ai_enabled: true
})`;

const REDIS_SETUP = `# Redis key pattern: ai_control:{session_id}
# Value: "true" (AI ON) or "false" (AI OFF)

# Set AI ON for a session:
SET ai_control:YOUR_SESSION_ID true

# Check from CLI:
GET ai_control:YOUR_SESSION_ID`;

/* ── cURL / CLI examples ───────────────────────────────────────── */
const getCurl = (dbType: MainDbType, url: string): string => {
  switch (dbType) {
    case 'supabase':
      return `curl -X POST \\
  ${url} \\
  -H "Content-Type: application/json" \\
  -d '{"session_id": "YOUR_SESSION_ID"}'

# Response:
# {"ai_enabled": true}`;
    case 'postgresql':
      return `psql "postgresql://USER:PASS@HOST:5432/DB" \\
  -c "SELECT ai_enabled FROM ai_control WHERE session_id = 'YOUR_SESSION_ID';"`;
    case 'mysql':
      return `mysql -h HOST -u USER -p DB \\
  -e "SELECT ai_enabled FROM ai_control WHERE session_id = 'YOUR_SESSION_ID';"`;
    case 'mongodb':
      return `mongosh "mongodb://USER:PASS@HOST:27017/DB" --eval \\
  "db.ai_control.findOne({session_id:'YOUR_SESSION_ID'},{ai_enabled:1})"`;
    case 'redis':
      return `redis-cli -h HOST -p 6379 GET "ai_control:YOUR_SESSION_ID"
# Returns "true" or "false" (or nil if not set → defaults to AI ON)`;
    default:
      return '';
  }
};

/* ── n8n node instructions ─────────────────────────────────────── */
const N8N_NODES: Record<MainDbType, { node: string; fields: { label: string; value: string }[]; ifPath: string }> = {
  supabase: {
    node: 'HTTP Request',
    fields: [
      { label: 'Method', value: 'POST' },
      { label: 'URL', value: '(Edge Function URL above)' },
      { label: 'Body', value: '{ "session_id": "{{ $json.session_id }}" }' },
      { label: 'Returns', value: '{ "ai_enabled": true | false }' },
    ],
    ifPath: '{{ $json.ai_enabled }}',
  },
  postgresql: {
    node: 'Postgres',
    fields: [
      { label: 'Operation', value: 'Execute Query' },
      { label: 'Query', value: "SELECT ai_enabled FROM ai_control WHERE session_id = '{{ $json.session_id }}' LIMIT 1;" },
    ],
    ifPath: '{{ $json[0].ai_enabled }}',
  },
  mysql: {
    node: 'MySQL',
    fields: [
      { label: 'Operation', value: 'Execute Query' },
      { label: 'Query', value: "SELECT ai_enabled FROM ai_control WHERE session_id = '{{ $json.session_id }}' LIMIT 1;" },
    ],
    ifPath: '{{ $json[0].ai_enabled }}',
  },
  mongodb: {
    node: 'MongoDB',
    fields: [
      { label: 'Collection', value: 'ai_control' },
      { label: 'Operation', value: 'Find One' },
      { label: 'Filter', value: '{ "session_id": "{{ $json.session_id }}" }' },
    ],
    ifPath: '{{ $json.ai_enabled }}',
  },
  redis: {
    node: 'Redis',
    fields: [
      { label: 'Operation', value: 'Get' },
      { label: 'Key', value: 'ai_control:{{ $json.session_id }}' },
    ],
    ifPath: '{{ $json.value }}',
  },
};

/* ── Props ─────────────────────────────────────────────────────── */
interface AiControlGuideProps {
  defaultDbType?: MainDbType;
  edgeFnUrl?: string;
  accentColor?: string;
}

/* ══════════════════════════════════════════════════════════════════
   Main Component
═══════════════════════════════════════════════════════════════════ */
export function AiControlGuide({ defaultDbType = 'supabase', edgeFnUrl = '', accentColor = 'primary' }: AiControlGuideProps) {
  const [activeDb, setActiveDb] = useState<MainDbType>(defaultDbType);
  const [showSetupSql, setShowSetupSql] = useState(false);
  const [showCurl, setShowCurl] = useState(false);

  const n8n = N8N_NODES[activeDb];

  const getSetupCode = (): { code: string; lang: string } => {
    switch (activeDb) {
      case 'supabase':    return { code: AI_CONTROL_SQL, lang: 'sql' };
      case 'postgresql':  return { code: POSTGRESQL_SQL, lang: 'sql' };
      case 'mysql':       return { code: MYSQL_SQL, lang: 'sql' };
      case 'mongodb':     return { code: MONGODB_SETUP, lang: 'javascript' };
      case 'redis':       return { code: REDIS_SETUP, lang: 'bash' };
    }
  };

  const getSetupLabel = () => {
    switch (activeDb) {
      case 'supabase':   return <>Create <code className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono">ai_control</code> table in Supabase</>;
      case 'postgresql': return <>Create <code className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono">ai_control</code> table in PostgreSQL</>;
      case 'mysql':      return <>Create <code className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono">ai_control</code> table in MySQL</>;
      case 'mongodb':    return <>Set up <code className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono">ai_control</code> collection (MongoDB Shell)</>;
      case 'redis':      return <>Set Redis key pattern</>;
    }
  };

  const stepBall = (n: number) => (
    <span className="w-5 h-5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold flex items-center justify-center flex-shrink-0">{n}</span>
  );

  const urlDisplay = activeDb === 'supabase'
    ? (edgeFnUrl || 'https://<project-ref>.supabase.co/functions/v1/check-ai-status')
    : '';

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground leading-relaxed">
        There is an <strong className="text-foreground">AI ON/OFF toggle</strong> in the conversation header.
        {' '}Follow the steps below to set it up in your n8n workflow.
      </p>

      {/* ── DB Type Tabs ── */}
      <div className="flex items-center gap-1 flex-wrap">
        {DB_TYPES.map(db => (
          <button
            key={db.value}
            onClick={() => { setActiveDb(db.value); setShowSetupSql(false); setShowCurl(false); }}
            data-testid={`tab-db-${db.value}`}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-semibold transition-all border',
              activeDb === db.value
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400'
                : 'bg-muted/50 border-border/40 text-muted-foreground hover:text-foreground hover:bg-muted'
            )}
          >
            <span>{db.icon}</span> {db.label}
          </button>
        ))}
      </div>

      {/* ── Step 1: DB Setup ── */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          {stepBall(1)}
          <p className="text-xs font-semibold text-foreground">{getSetupLabel()}</p>
        </div>
        <div className="ml-7">
          <button
            onClick={() => setShowSetupSql(v => !v)}
            className="flex items-center gap-1 text-[11px] text-primary hover:text-primary/80 font-medium transition-colors mb-2"
            data-testid="button-toggle-setup-code"
          >
            {showSetupSql ? 'Hide' : 'Show Code'}
            <ChevronDown size={11} className={cn('transition-transform', showSetupSql && 'rotate-180')} />
          </button>
          {showSetupSql && <CopyBlock {...getSetupCode()} />}
        </div>
      </div>

      {/* ── Step 2: (Supabase only) Deploy edge function ── */}
      {activeDb === 'supabase' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {stepBall(2)}
            <p className="text-xs font-semibold text-foreground">Deploy Edge Function</p>
          </div>
          <div className="ml-7 space-y-2">
            <p className="text-[11px] text-muted-foreground">Run this command using Supabase CLI:</p>
            <CopyBlock code="supabase functions deploy check-ai-status" lang="bash" />
            {urlDisplay && (
              <div className="flex items-center gap-2 mt-2 p-2.5 rounded-xl bg-muted/40 border border-border/40">
                <code className="flex-1 text-[10px] font-mono text-primary break-all" data-testid="text-ai-edge-fn-url">{urlDisplay}</code>
                <button
                  onClick={() => { navigator.clipboard.writeText(urlDisplay); toast.success('URL copied!'); }}
                  className="flex-shrink-0 p-1.5 rounded-md hover:bg-muted transition-colors"
                  title="Copy URL"
                  data-testid="button-copy-edge-fn-url"
                >
                  <ClipboardCopy size={11} className="text-muted-foreground" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Step 2/3: n8n Node setup ── */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          {stepBall(activeDb === 'supabase' ? 3 : 2)}
          <p className="text-xs font-semibold text-foreground">
            Add a <strong>{n8n.node}</strong> node to your n8n Workflow
          </p>
        </div>
        <div className="ml-7 rounded-xl border border-border/50 bg-muted/30 overflow-hidden divide-y divide-border/30">
          {n8n.fields.map(f => (
            <div key={f.label} className="px-3.5 py-2.5 flex items-start gap-3">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide w-24 flex-shrink-0 mt-0.5">{f.label}</span>
              <code className="text-[10px] font-mono text-foreground break-all">{f.value}</code>
            </div>
          ))}
        </div>
      </div>

      {/* ── Step: IF node ── */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          {stepBall(activeDb === 'supabase' ? 4 : 3)}
          <p className="text-xs font-semibold text-foreground">Add an IF node to conditionally route AI replies</p>
        </div>
        <div className="ml-7 rounded-xl border border-border/50 bg-muted/30 px-3.5 py-3 space-y-1.5">
          <p className="text-[11px] text-muted-foreground">Add an <strong>IF node</strong> after the {n8n.node} node:</p>
          <div className="flex flex-wrap items-center gap-2 mt-1.5">
            <code className="text-[10px] font-mono bg-background border border-border/60 px-2 py-1 rounded-lg text-foreground">{n8n.ifPath}</code>
            <span className="text-[10px] text-muted-foreground">equals</span>
            <code className="text-[10px] font-mono bg-background border border-border/60 px-2 py-1 rounded-lg text-emerald-600">
              {activeDb === 'redis' ? '"true"' : activeDb === 'mysql' ? '1' : 'true'}
            </code>
          </div>
          <p className="text-[10px] text-muted-foreground mt-2">
            <span className="text-emerald-600 font-semibold">TRUE branch</span> → AI Agent node (will reply)<br />
            <span className="text-red-500 font-semibold">FALSE branch</span> → No action (will not reply)
          </p>
        </div>
      </div>

      {/* ── cURL / CLI Test ── */}
      <div className="space-y-2">
        <button
          onClick={() => setShowCurl(v => !v)}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground font-medium transition-colors"
          data-testid="button-toggle-curl"
        >
          <Terminal size={12} />
          {showCurl ? 'Hide cURL/CLI' : 'Test with cURL / CLI'}
          <ChevronDown size={11} className={cn('transition-transform', showCurl && 'rotate-180')} />
        </button>
        {showCurl && (
          <CopyBlock
            code={getCurl(activeDb, urlDisplay)}
            lang={activeDb === 'supabase' ? 'bash' : activeDb === 'mongodb' ? 'bash' : activeDb === 'redis' ? 'bash' : 'bash'}
          />
        )}
      </div>

      {/* ── Note ── */}
      <div className="rounded-xl bg-amber-500/8 border border-amber-400/20 px-3.5 py-2.5">
        <p className="text-[10px] text-amber-700 dark:text-amber-400 leading-relaxed">
          <strong>Note:</strong> Clicking the AI toggle in any conversation saves the status to the DB. When n8n workflow runs, it checks that session's AI status and decides whether to reply or not.
          {activeDb === 'redis' && ' If key is missing in Redis (nil) → treat as AI ON.'}
          {activeDb === 'mysql' && ' In MySQL: ai_enabled = 1 means ON, 0 means OFF.'}
        </p>
      </div>
    </div>
  );
}
