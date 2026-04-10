import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useTeamRole } from '@/hooks/useTeamRole';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  ArrowLeft, LogOut, Pencil, Check, X, Copy, Trash2,
  ChevronDown, ChevronUp, ShieldCheck, Eye, Loader2, Link2, Camera, AlertTriangle,
  ClipboardCopy, Users, Database, Plus, Zap, ChevronRight, Clock,
  BookOpen, MessageSquare, ShoppingCart, HandIcon, Bot, KeyRound, Contact,
} from 'lucide-react';
import {
  getConnections, getActiveConnection, setActiveConnection,
  deleteConnection, MAX_CONNECTIONS, MainDbConnection,
  DB_TYPES, getConnectionDisplayUrl,
} from '@/lib/db-config';
import { clearGuestSession } from '@/lib/guestSession';
import { signOutMember, hasMemberSetup } from '@/lib/memberAuth';
import { clearAdminSession, getAdminEmail, updateAdminCredentials, hashPassword, verifyAdminCredentials, getAdminDisplayName, setAdminDisplayName, getAdminAvatarUrl, setAdminAvatarUrl } from '@/lib/adminAuth';

const INVITE_FIX_SQL = `-- Step 1: Create team_invites table (safe on fresh AND existing databases)
CREATE TABLE IF NOT EXISTS public.team_invites (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  text NOT NULL DEFAULT '',
  role                   text NOT NULL DEFAULT 'viewer',
  created_by             uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  permissions            text[] NOT NULL DEFAULT '{}',
  token                  uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  status                 text NOT NULL DEFAULT 'pending',
  accepted_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  submitted_name         text,
  submitted_email        text,
  submitted_password_hash text,
  submitted_at           timestamptz,
  last_login_at          timestamptz,
  created_at             timestamptz DEFAULT now()
);

-- Step 2: Add any missing columns for existing installs (safe no-ops if already present)
ALTER TABLE public.team_invites
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS permissions text[] DEFAULT '{}' NOT NULL,
  ADD COLUMN IF NOT EXISTS token uuid DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending' NOT NULL,
  ADD COLUMN IF NOT EXISTS accepted_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_name text,
  ADD COLUMN IF NOT EXISTS submitted_email text,
  ADD COLUMN IF NOT EXISTS submitted_password_hash text,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- Migrate data from old invited_by column if it exists
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'team_invites' AND column_name = 'invited_by') THEN
    UPDATE public.team_invites SET created_by = invited_by WHERE created_by IS NULL;
  END IF;
END $$;

ALTER TABLE public.team_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage invites" ON public.team_invites;
DROP POLICY IF EXISTS "Allow all for team_invites" ON public.team_invites;
CREATE POLICY "Allow all for team_invites" ON public.team_invites
  FOR ALL USING (true) WITH CHECK (true);

-- Step 3: RPC for reading a pending invite by token (admin-level, SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.get_invite_by_token(p_token uuid)
RETURNS TABLE (id uuid, email text, role text, permissions text[], status text, created_by uuid)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id, email, role, permissions, status, created_by
  FROM public.team_invites WHERE token = p_token AND status = 'pending';
$$;

-- Step 4: RPC for members to submit their registration request (bypasses RLS safely)
CREATE OR REPLACE FUNCTION public.submit_invite_request(
  p_token uuid,
  p_name text,
  p_email text,
  p_password_hash text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.team_invites
  WHERE token = p_token AND status = 'pending';
  IF v_id IS NULL THEN RETURN 'not_found'; END IF;
  UPDATE public.team_invites SET
    submitted_name = p_name,
    submitted_email = p_email,
    submitted_password_hash = p_password_hash,
    submitted_at = now()
  WHERE id = v_id;
  RETURN 'ok';
END;
$$;

-- Step 5: RPC for member login — validates credentials server-side (bypasses RLS)
CREATE OR REPLACE FUNCTION public.member_login_by_credentials(
  p_email text,
  p_password_hash text
)
RETURNS TABLE (
  id uuid,
  role text,
  permissions text[],
  submitted_name text,
  submitted_email text
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_email text := lower(trim(p_email));
BEGIN
  UPDATE public.team_invites ti SET last_login_at = NOW()
  WHERE ti.submitted_email = v_email
    AND ti.submitted_password_hash = p_password_hash
    AND ti.status = 'accepted';
  RETURN QUERY
  SELECT t.id, t.role, t.permissions, t.submitted_name, t.submitted_email
  FROM public.team_invites t
  WHERE t.submitted_email = v_email
    AND t.submitted_password_hash = p_password_hash
    AND t.status = 'accepted';
END;
$$;

-- Step 6: RPC to list ALL invites for admin dashboard (SECURITY DEFINER bypasses RLS)
CREATE OR REPLACE FUNCTION public.list_team_invites()
RETURNS TABLE (
  id uuid,
  email text,
  role text,
  created_by uuid,
  permissions text[],
  token uuid,
  status text,
  accepted_user_id uuid,
  submitted_name text,
  submitted_email text,
  submitted_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz
)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id, email, role, created_by, permissions, token, status,
         accepted_user_id, submitted_name, submitted_email,
         submitted_at, last_login_at, created_at
  FROM public.team_invites
  ORDER BY created_at DESC NULLS LAST;
$$;

-- Step 7: RPC to create an invite (SECURITY DEFINER — bypasses RLS for admin without auth.uid)
CREATE OR REPLACE FUNCTION public.create_team_invite(
  p_email text,
  p_role text,
  p_permissions text[]
)
RETURNS TABLE (id uuid, token uuid)
LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO public.team_invites (email, role, permissions)
  VALUES (p_email, p_role, p_permissions)
  RETURNING id, token;
$$;

-- Step 8: RPC to update invite status (SECURITY DEFINER — bypasses RLS)
CREATE OR REPLACE FUNCTION public.update_invite_status(p_id uuid, p_status text)
RETURNS void
LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE public.team_invites SET status = p_status WHERE id = p_id;
$$;

-- Step 9: RPC to delete an invite (SECURITY DEFINER — bypasses RLS)
CREATE OR REPLACE FUNCTION public.delete_team_invite(p_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM public.team_invites WHERE id = p_id;
$$;`;

const PG_SETUP_SQL = `-- PostgreSQL: Create team_invites table (auto-created by API server on first invite)
CREATE TABLE IF NOT EXISTS team_invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by  TEXT NOT NULL,
  email       TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'viewer',
  permissions TEXT[] NOT NULL DEFAULT '{}',
  token       UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  status      TEXT NOT NULL DEFAULT 'pending',
  submitted_name          TEXT,
  submitted_email         TEXT,
  submitted_password_hash TEXT,
  submitted_at            TIMESTAMPTZ,
  last_login_at           TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_invites_token      ON team_invites(token);
CREATE INDEX IF NOT EXISTS idx_team_invites_created_by ON team_invites(created_by);
CREATE INDEX IF NOT EXISTS idx_team_invites_status     ON team_invites(status);`;

const MYSQL_SETUP_SQL = `-- MySQL: Create team_invites table (auto-created by API server on first invite)
CREATE TABLE IF NOT EXISTS team_invites (
  id                      VARCHAR(36)  NOT NULL DEFAULT (UUID()),
  created_by              VARCHAR(255) NOT NULL,
  email                   VARCHAR(255) NOT NULL DEFAULT '',
  role                    VARCHAR(50)  NOT NULL DEFAULT 'viewer',
  permissions             JSON         NOT NULL DEFAULT (JSON_ARRAY()),
  token                   VARCHAR(36)  NOT NULL DEFAULT (UUID()),
  status                  VARCHAR(20)  NOT NULL DEFAULT 'pending',
  submitted_name          VARCHAR(255),
  submitted_email         VARCHAR(255),
  submitted_password_hash VARCHAR(64),
  submitted_at            DATETIME,
  last_login_at           DATETIME,
  created_at              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_token (token)
);

CREATE INDEX idx_created_by ON team_invites(created_by);
CREATE INDEX idx_status     ON team_invites(status);`;

const MONGO_SETUP_JS = `// MongoDB: Collections are auto-created by the API server on first invite.
// You can optionally create indexes manually for better performance:

db.team_invites.createIndex({ token: 1 }, { unique: true });
db.team_invites.createIndex({ created_by: 1 });
db.team_invites.createIndex({ status: 1 });
db.team_invites.createIndex({ submitted_email: 1 });

// Sample document structure:
// {
//   _id: ObjectId(),
//   created_by: "user-id",
//   email: "member@example.com",
//   role: "viewer",
//   permissions: ["overview", "messages"],
//   token: "uuid-v4-string",
//   status: "pending",          // pending | accepted | rejected | revoked
//   submitted_name: null,
//   submitted_email: null,
//   submitted_password_hash: null,
//   submitted_at: null,
//   created_at: ISODate()
// }`;

const REDIS_SETUP_NOTE = `# Redis: No schema setup needed — keys are managed automatically by the API server.
#
# Key structure used internally:
#   invite:{token}         → JSON blob of the invite record
#   invites:{userId}       → Set of invite IDs for a given admin
#
# The API server creates and manages all Redis keys automatically
# when the first invite is generated. No manual steps required.`;

type DbSetupTab = 'supabase' | 'postgresql' | 'mysql' | 'mongodb' | 'redis';
const DB_SETUP_TABS: { key: DbSetupTab; label: string; icon: string }[] = [
  { key: 'supabase',    label: 'Supabase',    icon: '⚡' },
  { key: 'postgresql',  label: 'PostgreSQL',  icon: '🐘' },
  { key: 'mysql',       label: 'MySQL',       icon: '🐬' },
  { key: 'mongodb',     label: 'MongoDB',     icon: '🍃' },
  { key: 'redis',       label: 'Redis',       icon: '🔴' },
];

const SqlCopyBlock = ({ sql }: { sql: string }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(sql); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* ignore */ }
  };
  return (
    <div className="relative rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden">
      <pre className="text-[10px] font-mono text-zinc-400 p-4 overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-44">{sql}</pre>
      <button
        onClick={handleCopy}
        className="absolute top-2.5 right-2.5 flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-semibold transition-colors"
        data-testid="button-copy-sql"
      >
        <ClipboardCopy size={10} /> {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
};

/* ── SQL Setup Guide (all 8 tables) ─────────────────────────────────────── */

const SETUP_GUIDES = [
  {
    id: 'messages', icon: <MessageSquare size={15} />, title: 'Chat / Messages', color: 'blue',
    description: 'Stores all chat messages from n8n AI conversations. This is the main table your n8n workflow writes to.',
    sql: `CREATE TABLE IF NOT EXISTS sessions (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT        NOT NULL,
  message       JSONB       NOT NULL,
  recipient     TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_recipient  ON sessions(recipient);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
ALTER TABLE sessions REPLICA IDENTITY FULL;`,
  },
  {
    id: 'orders', icon: <ShoppingCart size={15} />, title: 'Orders', color: 'emerald',
    description: 'Stores customer orders created via AI chat. Supports multiple courier providers.',
    sql: `CREATE TABLE IF NOT EXISTS orders (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          TEXT,
  recipient_id        TEXT,
  customer_name       TEXT,
  customer_phone      TEXT,
  customer_address    TEXT,
  product_name        TEXT        NOT NULL,
  quantity            INT         NOT NULL DEFAULT 1,
  unit_price          NUMERIC,
  total_price         NUMERIC,
  payment_status      TEXT                 DEFAULT 'unpaid',
  status              TEXT        NOT NULL DEFAULT 'pending',
  notes               TEXT,
  order_data          JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_session_id ON orders(session_id);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
ALTER TABLE orders REPLICA IDENTITY FULL;`,
  },
  {
    id: 'handoff', icon: <HandIcon size={15} />, title: 'Handoff Requests', color: 'orange',
    description: 'When the AI cannot handle a conversation, it creates a handoff request for a human agent.',
    sql: `CREATE TABLE IF NOT EXISTS handoff_requests (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  TEXT,
  recipient   TEXT,
  reason      TEXT        NOT NULL DEFAULT 'Human requested',
  message     TEXT,
  priority    TEXT        NOT NULL DEFAULT 'normal',
  status      TEXT        NOT NULL DEFAULT 'pending',
  agent_data  JSONB,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_handoff_status     ON handoff_requests(status);
CREATE INDEX IF NOT EXISTS idx_handoff_session_id ON handoff_requests(session_id);
ALTER TABLE handoff_requests REPLICA IDENTITY FULL;`,
  },
  {
    id: 'ai_control', icon: <Bot size={15} />, title: 'AI Control', color: 'violet',
    description: 'Controls whether the AI is enabled or disabled per chat session.',
    sql: `CREATE TABLE IF NOT EXISTS ai_control (
  session_id  TEXT        PRIMARY KEY,
  ai_enabled  BOOLEAN     NOT NULL DEFAULT TRUE,
  user_id     TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE ai_control REPLICA IDENTITY FULL;`,
  },
  {
    id: 'failed', icon: <AlertTriangle size={15} />, title: 'Failed Automations', color: 'red',
    description: 'Logs errors from automation workflows so you can investigate and resolve them.',
    sql: `CREATE TABLE IF NOT EXISTS failed_automations (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     TEXT,
  workflow_name  TEXT,
  error_message  TEXT        NOT NULL,
  error_details  JSONB,
  severity       TEXT        DEFAULT 'error',
  resolved       BOOLEAN     DEFAULT FALSE,
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_failed_resolved   ON failed_automations(resolved);
CREATE INDEX IF NOT EXISTS idx_failed_created_at ON failed_automations(created_at DESC);
ALTER TABLE failed_automations REPLICA IDENTITY FULL;`,
  },
  {
    id: 'team', icon: <Users size={15} />, title: 'Team Management', color: 'indigo',
    description: 'Manage your team members and control their access with roles and permissions.',
    sql: `CREATE TABLE IF NOT EXISTS app_owner (
  user_id    TEXT        PRIMARY KEY,
  claimed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_invites (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by       TEXT         NOT NULL,
  email            TEXT         NOT NULL,
  role             TEXT         NOT NULL DEFAULT 'agent',
  permissions      TEXT[]       NOT NULL DEFAULT '{}',
  token            TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  status           TEXT         NOT NULL DEFAULT 'pending',
  accepted_user_id TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_invites_token ON team_invites(token);`,
  },
  {
    id: 'api_keys', icon: <KeyRound size={15} />, title: 'API Keys', color: 'cyan',
    description: 'Stores API keys for webhook authentication and external integrations.',
    sql: `CREATE TABLE IF NOT EXISTS api_keys (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT        NOT NULL,
  label      TEXT,
  api_key    TEXT        NOT NULL DEFAULT concat('sk-', gen_random_uuid()::text),
  is_active  BOOLEAN     DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);`,
  },
  {
    id: 'contacts', icon: <Contact size={15} />, title: 'Contacts / Recipients', color: 'pink',
    description: 'Maps recipient IDs (phone numbers / user IDs) to human-readable names.',
    sql: `CREATE TABLE IF NOT EXISTS recipient_names (
  recipient_id TEXT        PRIMARY KEY,
  name         TEXT        NOT NULL,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);`,
  },
];

/* ── DbSetupCard ──────────────────────────────────────────────────────────── */
const DbSetupCard = ({
  dbConnections,
  dbSetupStatus,
  activeDbId,
}: {
  dbConnections: MainDbConnection[];
  dbSetupStatus: Record<string, 'checking' | 'ok' | 'needed'>;
  activeDbId: string | null;
}) => {
  const [activeTab, setActiveTab] = useState<DbSetupTab>('supabase');

  const supabaseConns = dbConnections.filter(c => !c.dbType || c.dbType === 'supabase');
  const neededCount = supabaseConns.filter(c => dbSetupStatus[c.id] === 'needed').length;
  const checkingCount = supabaseConns.filter(c => dbSetupStatus[c.id] === 'checking').length;
  const supabaseAllOk = supabaseConns.length === 0 || (neededCount === 0 && checkingCount === 0);

  const visibleTabs = DB_SETUP_TABS;
  const effectiveTab = activeTab;

  const sqlEditorUrl = (url: string) => {
    const match = url.match(/https?:\/\/([^.]+)\.supabase\.co/);
    const ref = match?.[1];
    return ref ? `https://supabase.com/dashboard/project/${ref}/sql/new` : 'https://supabase.com/dashboard';
  };

  const headerBadge = supabaseAllOk && !dbConnections.some(c => c.dbType && c.dbType !== 'supabase' && dbSetupStatus[c.id] === 'needed') ? (
    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20">All configured</span>
  ) : checkingCount > 0 && neededCount === 0 ? (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground border border-border/40">Checking…</span>
  ) : neededCount > 0 ? (
    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">{neededCount} need setup</span>
  ) : (
    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">Auto-configured</span>
  );

  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden" data-testid="card-db-setup">
      {/* Header */}
      <div className="px-5 py-3.5 border-b border-border/50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database size={14} className={neededCount > 0 ? 'text-amber-500' : 'text-green-500'} />
          <span className="font-semibold text-sm">Database Setup</span>
          {headerBadge}
        </div>
        <span className="text-[10px] text-muted-foreground">One-time per project</span>
      </div>

      {/* Tabs */}
      {visibleTabs.length > 1 && (
        <div className="flex border-b border-border/50 overflow-x-auto bg-muted/20">
          {visibleTabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2.5 text-[11px] font-semibold whitespace-nowrap transition-colors border-b-2',
                effectiveTab === tab.key
                  ? 'border-primary text-primary bg-background'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/30',
              )}
            >
              <span>{tab.icon}</span> {tab.label}
            </button>
          ))}
        </div>
      )}

      <div className="p-5 space-y-4">
        {/* ── Supabase tab ── */}
        {effectiveTab === 'supabase' && (
          <>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Each Supabase database needs the member-auth SQL run once. Copy the SQL below, open the SQL Editor for each database that needs setup, paste and click <strong>Run</strong>.
            </p>
            <div>
              <p className="text-[11px] font-semibold text-foreground mb-1.5 flex items-center gap-1.5">
                <span className="w-4 h-4 rounded-full bg-primary/10 text-primary text-[9px] font-bold flex items-center justify-center">1</span>
                Copy this SQL
              </p>
              <SqlCopyBlock sql={INVITE_FIX_SQL} />
            </div>
            {supabaseConns.length > 0 && (
              <div>
                <p className="text-[11px] font-semibold text-foreground mb-2 flex items-center gap-1.5">
                  <span className="w-4 h-4 rounded-full bg-primary/10 text-primary text-[9px] font-bold flex items-center justify-center">2</span>
                  Open SQL Editor for each database and run
                </p>
                <div className="rounded-xl border border-border/60 overflow-hidden divide-y divide-border/40">
                  {supabaseConns.map(conn => {
                    const status = dbSetupStatus[conn.id];
                    return (
                      <div key={conn.id} className="flex items-center gap-3 px-4 py-3 bg-muted/10">
                        <div className={cn('w-2 h-2 rounded-full flex-shrink-0', {
                          'bg-muted-foreground/30 animate-pulse': status === 'checking',
                          'bg-green-500': status === 'ok',
                          'bg-amber-500': status === 'needed',
                          'bg-muted-foreground/20': !status,
                        })} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm leading-none">⚡</span>
                            <p className="text-[12px] font-medium truncate">{conn.name}</p>
                            {conn.id === activeDbId && (
                              <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/15">Active</span>
                            )}
                          </div>
                          <p className="text-[10px] text-muted-foreground truncate font-mono mt-0.5 pl-[22px]">
                            {conn.url.replace(/^https?:\/\//, '')}
                          </p>
                        </div>
                        <div className="flex-shrink-0">
                          {status === 'checking' && <span className="text-[10px] text-muted-foreground italic">Checking…</span>}
                          {status === 'ok' && (
                            <span className="flex items-center gap-1 text-[10px] font-semibold text-green-600 dark:text-green-400">
                              <Check size={11} /> Setup done
                            </span>
                          )}
                          {(status === 'needed' || !status) && (
                            <a href={sqlEditorUrl(conn.url)} target="_blank" rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-[10px] font-semibold transition-colors">
                              <Link2 size={10} /> Open SQL Editor ↗
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {!supabaseAllOk && (
                  <p className="text-[10px] text-muted-foreground mt-2">After running the SQL, refresh this page to confirm setup.</p>
                )}
              </div>
            )}
          </>
        )}

        {/* ── PostgreSQL tab ── */}
        {effectiveTab === 'postgresql' && (
          <>
            <div className="flex items-start gap-2.5 rounded-xl bg-blue-500/8 border border-blue-500/20 p-3">
              <span className="text-base leading-none mt-0.5">🐘</span>
              <div>
                <p className="text-[11px] font-semibold text-blue-700 dark:text-blue-400">Auto-created by the system</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                  When you generate the first invite, the API server automatically creates the <code className="font-mono bg-muted px-1 rounded text-[10px]">team_invites</code> table. The SQL below is for manual reference or if you prefer to set it up in advance.
                </p>
              </div>
            </div>
            <div>
              <p className="text-[11px] font-semibold text-foreground mb-1.5">PostgreSQL — Create Table SQL</p>
              <SqlCopyBlock sql={PG_SETUP_SQL} />
            </div>
            {(() => {
              const pgConns = dbConnections.filter(c => c.dbType === 'postgresql');
              return pgConns.length === 0 ? (
                <p className="text-[11px] text-muted-foreground italic">No PostgreSQL connections added yet. Add one from Database Connections above.</p>
              ) : (
                <div className="rounded-xl border border-border/60 overflow-hidden divide-y divide-border/40">
                  {pgConns.map(conn => (
                    <div key={conn.id} className="flex items-center gap-3 px-4 py-3 bg-muted/10">
                      <div className="w-2 h-2 rounded-full bg-blue-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm leading-none">🐘</span>
                          <p className="text-[12px] font-medium truncate">{conn.name}</p>
                          {conn.id === activeDbId && (
                            <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/15">Active</span>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground truncate font-mono mt-0.5 pl-[22px]">{conn.url.replace(/^postgresql?:\/\//, 'pg://')}</p>
                      </div>
                      <span className="text-[10px] font-semibold text-blue-600 dark:text-blue-400 flex-shrink-0">Auto-configured</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </>
        )}

        {/* ── MySQL tab ── */}
        {effectiveTab === 'mysql' && (
          <>
            <div className="flex items-start gap-2.5 rounded-xl bg-orange-500/8 border border-orange-500/20 p-3">
              <span className="text-base leading-none mt-0.5">🐬</span>
              <div>
                <p className="text-[11px] font-semibold text-orange-700 dark:text-orange-400">Auto-created by the system</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                  The <code className="font-mono bg-muted px-1 rounded text-[10px]">team_invites</code> table is created automatically on first invite. The SQL below is for manual reference or advance setup.
                </p>
              </div>
            </div>
            <div>
              <p className="text-[11px] font-semibold text-foreground mb-1.5">MySQL — Create Table SQL</p>
              <SqlCopyBlock sql={MYSQL_SETUP_SQL} />
            </div>
            {(() => {
              const myConns = dbConnections.filter(c => c.dbType === 'mysql');
              return myConns.length === 0 ? (
                <p className="text-[11px] text-muted-foreground italic">No MySQL connections added yet. Add one from Database Connections above.</p>
              ) : (
                <div className="rounded-xl border border-border/60 overflow-hidden divide-y divide-border/40">
                  {myConns.map(conn => (
                    <div key={conn.id} className="flex items-center gap-3 px-4 py-3 bg-muted/10">
                      <div className="w-2 h-2 rounded-full bg-orange-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm leading-none">🐬</span>
                          <p className="text-[12px] font-medium truncate">{conn.name}</p>
                          {conn.id === activeDbId && (
                            <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/15">Active</span>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground truncate font-mono mt-0.5 pl-[22px]">{conn.url}</p>
                      </div>
                      <span className="text-[10px] font-semibold text-orange-600 dark:text-orange-400 flex-shrink-0">Auto-configured</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </>
        )}

        {/* ── MongoDB tab ── */}
        {effectiveTab === 'mongodb' && (
          <>
            <div className="flex items-start gap-2.5 rounded-xl bg-green-500/8 border border-green-500/20 p-3">
              <span className="text-base leading-none mt-0.5">🍃</span>
              <div>
                <p className="text-[11px] font-semibold text-green-700 dark:text-green-400">No schema setup needed (NoSQL)</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                  MongoDB collections are schema-less and created automatically on first insert. The code below shows optional index creation for better performance.
                </p>
              </div>
            </div>
            <div>
              <p className="text-[11px] font-semibold text-foreground mb-1.5">MongoDB — Optional Index Setup (mongosh)</p>
              <SqlCopyBlock sql={MONGO_SETUP_JS} />
            </div>
            {(() => {
              const mgConns = dbConnections.filter(c => c.dbType === 'mongodb');
              return mgConns.length === 0 ? (
                <p className="text-[11px] text-muted-foreground italic">No MongoDB connections added yet. Add one from Database Connections above.</p>
              ) : (
                <div className="rounded-xl border border-border/60 overflow-hidden divide-y divide-border/40">
                  {mgConns.map(conn => (
                    <div key={conn.id} className="flex items-center gap-3 px-4 py-3 bg-muted/10">
                      <div className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm leading-none">🍃</span>
                          <p className="text-[12px] font-medium truncate">{conn.name}</p>
                          {conn.id === activeDbId && (
                            <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/15">Active</span>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground truncate font-mono mt-0.5 pl-[22px]">{conn.url.replace(/mongodb(\+srv)?:\/\/[^@]+@/, 'mongodb://***@')}</p>
                      </div>
                      <span className="text-[10px] font-semibold text-green-600 dark:text-green-400 flex-shrink-0">Auto-configured</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </>
        )}

        {/* ── Redis tab ── */}
        {effectiveTab === 'redis' && (
          <>
            <div className="flex items-start gap-2.5 rounded-xl bg-red-500/8 border border-red-500/20 p-3">
              <span className="text-base leading-none mt-0.5">🔴</span>
              <div>
                <p className="text-[11px] font-semibold text-red-700 dark:text-red-400">No schema setup needed (Key-Value Store)</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                  Redis is a key-value store — there are no tables or schemas. All keys are created automatically by the API server when invites are generated.
                </p>
              </div>
            </div>
            <div>
              <p className="text-[11px] font-semibold text-foreground mb-1.5">Redis — Key Structure Reference</p>
              <SqlCopyBlock sql={REDIS_SETUP_NOTE} />
            </div>
            {(() => {
              const rdConns = dbConnections.filter(c => c.dbType === 'redis');
              return rdConns.length === 0 ? (
                <p className="text-[11px] text-muted-foreground italic">No Redis connections added yet. Add one from Database Connections above.</p>
              ) : (
                <div className="rounded-xl border border-border/60 overflow-hidden divide-y divide-border/40">
                  {rdConns.map(conn => (
                    <div key={conn.id} className="flex items-center gap-3 px-4 py-3 bg-muted/10">
                      <div className="w-2 h-2 rounded-full bg-red-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm leading-none">🔴</span>
                          <p className="text-[12px] font-medium truncate">{conn.name}</p>
                          {conn.id === activeDbId && (
                            <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/15">Active</span>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground truncate font-mono mt-0.5 pl-[22px]">{conn.url.replace(/redis:\/\/[^@]+@/, 'redis://***@')}</p>
                      </div>
                      <span className="text-[10px] font-semibold text-red-600 dark:text-red-400 flex-shrink-0">Auto-configured</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
};

/* ================================================================ */
const Profile = () => {
  const navigate = useNavigate();
  const { user, isAdmin, displayName, initials, loading: pageLoading } = useTeamRole();

  const [editName, setEditName] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [isSavingName, setIsSavingName] = useState(false);

  const [dbSetupStatus, setDbSetupStatus] = useState<Record<string, 'checking' | 'ok' | 'needed'>>({});

  const [avatarUrl, setAvatarUrl] = useState('');
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);

  // ── Admin credentials change ─────────────────────────────────────────────
  const [credEmail, setCredEmail] = useState(() => getAdminEmail());
  const [credPassword, setCredPassword] = useState('');
  const [credConfirm, setCredConfirm] = useState('');
  const [credCurrentPw, setCredCurrentPw] = useState('');
  const [credSaving, setCredSaving] = useState(false);
  const [credError, setCredError] = useState('');
  const [credSuccess, setCredSuccess] = useState(false);

  const [dbConnections, setDbConnections] = useState<MainDbConnection[]>([]);
  const [activeDbId, setActiveDbId] = useState<string | null>(null);
  const [dbDeleteConfirmId, setDbDeleteConfirmId] = useState<string | null>(null);
  useEffect(() => {
    const conns = getConnections();
    const active = getActiveConnection();
    setDbConnections(conns);
    setActiveDbId(active?.id || null);
  }, []);

  useEffect(() => {
    if (displayName && !isEditingName) setEditName(displayName);
  }, [displayName]);


  // Auto-detect missing RPCs for ALL Supabase connections
  useEffect(() => {
    if (!isAdmin || pageLoading) return;
    const conns = getConnections().filter(c => c.dbType === 'supabase' && c.url && c.anonKey);
    if (conns.length === 0) return;
    const initial: Record<string, 'checking' | 'ok' | 'needed'> = {};
    conns.forEach(c => { initial[c.id] = 'checking'; });
    setDbSetupStatus(initial);
    conns.forEach(async (conn) => {
      try {
        const { createClient } = await import('@supabase/supabase-js');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client = createClient(conn.url, conn.anonKey) as any;
        const { error } = await client.rpc('member_login_by_credentials', {
          p_email: '__probe__', p_password_hash: '__probe__',
        });
        const needed = !!error && (error.message?.includes('does not exist') || error.message?.includes('function'));
        setDbSetupStatus(prev => ({ ...prev, [conn.id]: needed ? 'needed' : 'ok' }));
      } catch {
        setDbSetupStatus(prev => ({ ...prev, [conn.id]: 'needed' }));
      }
    });
  }, [isAdmin, pageLoading]);

  useEffect(() => {
    if (user?.user_metadata?.avatar_url) {
      setAvatarUrl(user.user_metadata.avatar_url);
    } else if (isAdmin && !user) {
      // Admin is localStorage-only — load avatar from local storage
      const stored = getAdminAvatarUrl();
      if (stored) setAvatarUrl(stored);
    }
  }, [user, isAdmin]);

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Please select an image file'); return; }
    setIsUploadingAvatar(true);
    try {
      const objectUrl = URL.createObjectURL(file);
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const SIZE = 220;
          const canvas = document.createElement('canvas');
          canvas.width = SIZE; canvas.height = SIZE;
          const ctx = canvas.getContext('2d')!;
          const side = Math.min(img.width, img.height);
          ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
          URL.revokeObjectURL(objectUrl);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = reject;
        img.src = objectUrl;
      });
      if (isAdmin && !user) {
        // Admin: save to localStorage
        setAdminAvatarUrl(dataUrl);
        setAvatarUrl(dataUrl);
        toast.success('Profile photo updated!');
      } else if (user) {
        const { error } = await supabase.auth.updateUser({ data: { avatar_url: dataUrl } });
        if (error) { toast.error('Failed to save avatar'); return; }
        setAvatarUrl(dataUrl);
        toast.success('Profile photo updated!');
      }
    } catch {
      toast.error('Could not process image');
    } finally {
      setIsUploadingAvatar(false);
      e.target.value = '';
    }
  };

  const handleSaveName = async () => {
    if (!editName.trim()) return;
    setIsSavingName(true);
    try {
      if (isAdmin && !user) {
        // Admin: save name to localStorage
        setAdminDisplayName(editName.trim());
        toast.success('Name updated');
        setIsEditingName(false);
      } else if (user) {
        const { error } = await supabase.auth.updateUser({ data: { display_name: editName.trim() } });
        if (error) { toast.error('Failed to update name'); }
        else { toast.success('Name updated'); setIsEditingName(false); }
      }
    } finally { setIsSavingName(false); }
  };

  const handleSignOut = async () => {
    if (hasMemberSetup()) {
      await signOutMember();
      window.location.href = '/member-login';
    } else {
      clearAdminSession();
      clearGuestSession();
      await supabase.auth.signOut();
      navigate('/');
    }
  };

  // ── Save admin login credentials ────────────────────────────────────────────
  const handleSaveCredentials = async () => {
    setCredError('');
    setCredSuccess(false);
    const email = credEmail.trim();
    if (!email || !email.includes('@')) { setCredError('Enter a valid email address.'); return; }
    if (credPassword && credPassword !== credConfirm) { setCredError('Passwords do not match.'); return; }
    if (credPassword && credPassword.length < 6) { setCredError('Password must be at least 6 characters.'); return; }
    if (!credCurrentPw) { setCredError('Enter your current password to confirm changes.'); return; }

    setCredSaving(true);
    try {
      const currentEmail = getAdminEmail();
      const valid = await verifyAdminCredentials(currentEmail, credCurrentPw);
      if (!valid) { setCredError('Current password is incorrect.'); return; }

      const newHash = await hashPassword(credPassword || credCurrentPw);
      updateAdminCredentials(email, newHash);
      setCredSuccess(true);
      setCredPassword('');
      setCredConfirm('');
      setCredCurrentPw('');
      toast.success('Login credentials updated. Please sign in again.');
      setTimeout(() => {
        clearAdminSession();
        navigate('/');
      }, 1500);
    } catch {
      setCredError('Failed to update credentials.');
    } finally {
      setCredSaving(false);
    }
  };

  if (pageLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 size={22} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/20">

      {/* ── Top nav bar ── */}
      <div className="sticky top-0 z-10 bg-background/90 backdrop-blur-md border-b border-border/50">
        <div className="max-w-2xl mx-auto px-4 h-13 flex items-center justify-between">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors font-medium py-3"
            data-testid="button-back-dashboard"
          >
            <ArrowLeft size={14} /> Dashboard
          </button>
          <span className="text-[11px] font-bold text-muted-foreground tracking-widest uppercase">Account</span>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-destructive transition-colors py-3"
            data-testid="button-sign-out"
          >
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">

        {/* ── Profile Hero Card ── */}
        <div className="rounded-2xl overflow-hidden border border-border bg-card shadow-sm">
          <div className="h-20 bg-gradient-to-br from-primary/25 via-primary/10 to-primary/5 relative">
            <div className="absolute inset-0 opacity-30" style={{ backgroundImage: 'radial-gradient(circle at 20% 50%, hsl(var(--primary)) 0%, transparent 60%)' }} />
          </div>

          <div className="px-5 pb-5 -mt-10">
            <input id="avatar-file-input" type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} data-testid="input-avatar-file" />
            <div className="flex items-end justify-between mb-3">
              <label htmlFor="avatar-file-input" className="relative group cursor-pointer" title="Change photo">
                <div className="w-[72px] h-[72px] rounded-2xl ring-4 ring-card overflow-hidden bg-primary/10 flex items-center justify-center shadow-lg">
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" data-testid="img-avatar" />
                  ) : (
                    <span className="text-xl font-bold text-primary" data-testid="div-avatar-initials">{initials}</span>
                  )}
                </div>
                <div className="absolute inset-0 rounded-2xl bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  {isUploadingAvatar
                    ? <Loader2 size={16} className="text-white animate-spin" />
                    : <Camera size={16} className="text-white" />}
                </div>
              </label>

              <div className="mb-1">
                {isAdmin ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary bg-primary/10 px-3 py-1.5 rounded-full border border-primary/20">
                    <ShieldCheck size={11} /> Admin
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground bg-muted px-3 py-1.5 rounded-full border border-border">
                    <Eye size={11} /> Viewer
                  </span>
                )}
              </div>
            </div>

            {/* Name */}
            {isEditingName ? (
              <div className="flex items-center gap-2 mb-0.5">
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="h-8 text-base font-bold max-w-[200px] border-primary/40"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveName();
                    if (e.key === 'Escape') { setIsEditingName(false); setEditName(displayName); }
                  }}
                  data-testid="input-display-name"
                />
                <button onClick={handleSaveName} disabled={isSavingName} className="p-1.5 rounded-lg hover:bg-muted text-emerald-600">
                  {isSavingName ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                </button>
                <button onClick={() => { setIsEditingName(false); setEditName(displayName); }} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground">
                  <X size={13} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 group mb-0.5">
                <h1 className="text-lg font-bold text-foreground tracking-tight">{displayName}</h1>
                <button
                  onClick={() => setIsEditingName(true)}
                  className="p-1 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-muted transition-all"
                  data-testid="button-edit-name"
                >
                  <Pencil size={11} />
                </button>
              </div>
            )}
            <p className="text-[13px] text-muted-foreground">{user?.email}</p>
          </div>
        </div>

        {/* ── Login Credentials (admin only) ── */}
        {isAdmin && (
          <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-border/40 bg-gradient-to-r from-violet-50/60 to-transparent dark:from-violet-900/10 flex items-center gap-2">
              <KeyRound size={14} className="text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Login Credentials</h2>
            </div>
            <div className="px-5 py-5 space-y-4">
              <p className="text-[12px] text-muted-foreground">
                Change the admin email and password used to sign in. You must confirm your current password before saving.
              </p>

              {/* Email */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Email</label>
                <Input
                  type="email"
                  value={credEmail}
                  onChange={e => { setCredEmail(e.target.value); setCredError(''); setCredSuccess(false); }}
                  placeholder="admin@example.com"
                  className="h-9 text-sm"
                />
              </div>

              {/* New password */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">New Password <span className="font-normal normal-case">(leave blank to keep current)</span></label>
                <Input
                  type="password"
                  value={credPassword}
                  onChange={e => { setCredPassword(e.target.value); setCredError(''); setCredSuccess(false); }}
                  placeholder="New password"
                  className="h-9 text-sm"
                  autoComplete="new-password"
                />
              </div>

              {/* Confirm new password */}
              {credPassword && (
                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Confirm New Password</label>
                  <Input
                    type="password"
                    value={credConfirm}
                    onChange={e => { setCredConfirm(e.target.value); setCredError(''); setCredSuccess(false); }}
                    placeholder="Repeat new password"
                    className="h-9 text-sm"
                    autoComplete="new-password"
                  />
                </div>
              )}

              {/* Divider */}
              <div className="border-t border-border/40 pt-4 space-y-1.5">
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Current Password <span className="text-red-500">*</span></label>
                <Input
                  type="password"
                  value={credCurrentPw}
                  onChange={e => { setCredCurrentPw(e.target.value); setCredError(''); setCredSuccess(false); }}
                  placeholder="Enter current password to confirm"
                  className="h-9 text-sm"
                  autoComplete="current-password"
                />
              </div>

              {/* Error / success */}
              {credError && (
                <p className="text-[12px] text-red-500 flex items-center gap-1.5">
                  <X size={12} /> {credError}
                </p>
              )}
              {credSuccess && (
                <p className="text-[12px] text-emerald-600 flex items-center gap-1.5">
                  <Check size={12} /> Saved — signing you out…
                </p>
              )}

              <button
                onClick={handleSaveCredentials}
                disabled={credSaving}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-white text-[13px] font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60"
              >
                {credSaving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Save Credentials
              </button>
            </div>
          </div>
        )}

        {/* ── Database Connections ── */}
        <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border/50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database size={14} className="text-primary" />
              <span className="font-semibold text-sm">Database Connections</span>
              <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded-md border border-border/40">
                {dbConnections.length}/{MAX_CONNECTIONS}
              </span>
            </div>
            <button
              onClick={() => navigate('/connect')}
              className="flex items-center gap-1.5 text-[11px] font-medium text-primary hover:text-primary/80 transition-colors"
              data-testid="button-add-db-connection"
            >
              <Plus size={12} /> Add New
            </button>
          </div>

          {dbConnections.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <div className="w-10 h-10 rounded-2xl bg-muted mx-auto flex items-center justify-center mb-3">
                <Zap size={16} className="text-muted-foreground/50" />
              </div>
              <p className="text-sm text-muted-foreground mb-3">No database connected yet</p>
              <button
                onClick={() => navigate('/connect')}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary/80 transition-colors"
                data-testid="button-connect-first-db"
              >
                Connect a database <ChevronRight size={11} />
              </button>
            </div>
          ) : (
            <div className="divide-y divide-border/30">
              {dbConnections.map(conn => (
                <div
                  key={conn.id}
                  className={cn('flex items-center gap-3 px-5 py-3.5 transition-colors', conn.id === activeDbId ? 'bg-primary/4' : 'hover:bg-muted/20')}
                  data-testid={`card-db-connection-${conn.id}`}
                >
                  <div className={cn('w-2 h-2 rounded-full flex-shrink-0 mt-0.5', conn.id === activeDbId ? 'bg-green-500' : 'bg-muted-foreground/20')} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-base leading-none">
                        {DB_TYPES.find(t => t.value === (conn.dbType || 'supabase'))?.icon ?? '⚡'}
                      </span>
                      <p className="text-sm font-medium truncate">{conn.name}</p>
                    </div>
                    {getConnectionDisplayUrl(conn) && (
                      <p className="text-[10px] text-muted-foreground truncate font-mono mt-0.5 pl-[22px]">{getConnectionDisplayUrl(conn)}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {conn.id === activeDbId ? (
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-green-500/12 text-green-600 dark:text-green-400 border border-green-500/20">Active</span>
                    ) : (
                      <button
                        onClick={() => {
                          setActiveConnection(conn.id);
                          toast.success('Switching...');
                          setTimeout(() => { window.location.href = '/'; }, 600);
                        }}
                        className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground transition-colors border border-primary/20"
                        data-testid={`button-activate-db-${conn.id}`}
                      >
                        Switch
                      </button>
                    )}
                    {dbDeleteConfirmId === conn.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => {
                            deleteConnection(conn.id);
                            setDbConnections(getConnections());
                            const a = getActiveConnection();
                            setActiveDbId(a?.id || null);
                            setDbDeleteConfirmId(null);
                            toast.success('Removed');
                          }}
                          className="px-2 py-1 rounded-lg text-[10px] font-semibold bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
                          data-testid={`button-db-delete-confirm-${conn.id}`}
                        >Delete</button>
                        <button
                          onClick={() => setDbDeleteConfirmId(null)}
                          className="px-2 py-1 rounded-lg text-[10px] font-medium bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        >Cancel</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDbDeleteConfirmId(conn.id)}
                        className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                        title="Remove"
                        data-testid={`button-db-delete-${conn.id}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Database Setup ── */}
        {isAdmin && dbConnections.length > 0 && (
          <DbSetupCard
            dbConnections={dbConnections}
            dbSetupStatus={dbSetupStatus}
            activeDbId={activeDbId}
          />
        )}


      </div>
    </div>
  );
};

export default Profile;
