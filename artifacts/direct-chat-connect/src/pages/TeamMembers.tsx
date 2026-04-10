import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useTeamRole } from '@/hooks/useTeamRole';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  ArrowLeft, Check, UserPlus, Copy, Trash2, ChevronDown,
  ShieldCheck, Loader2, Link2, Users, Database, Clock,
  MoreHorizontal, UserCheck, UserX, ShieldOff,
  ClipboardCopy, Plus, Zap, ChevronRight,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  getActiveConnection, getConnections, setActiveConnection,
  deleteConnection, MAX_CONNECTIONS, MainDbConnection,
  DB_TYPES, getConnectionDisplayUrl,
} from '@/lib/db-config';
import { getStoredConnection } from '@/lib/externalDb';
import {
  buildCreds, encodeNonSupabaseCreds,
  proxyInit, proxyListInvites, proxyCreateInvite,
  proxyUpdateInvite, proxyDeleteInvite,
} from '@/lib/memberAuthProxy';

const PLATFORM_CONNS_KEY = 'chat_monitor_platform_connections';
const N8N_SETTINGS_KEY = 'chat_monitor_n8n_settings';

/* ── Database Setup SQL constants ────────────────────────────────────────── */
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
type Invite = {
  id: string;
  email: string;
  role: string;
  permissions: string[];
  token: string;
  status: string;
  accepted_user_id: string | null;
  created_at: string;
  submitted_name: string | null;
  submitted_email: string | null;
  submitted_at: string | null;
  last_login_at?: string | null;
};

const PERMISSION_OPTIONS = [
  { key: 'overview',   label: 'Overview' },
  { key: 'messages',   label: 'Messages' },
  { key: 'handoff',    label: 'Handoff' },
  { key: 'failed',     label: 'Failed' },
  { key: 'orders',     label: 'Orders' },
  { key: 'n8n_prompt', label: 'n8n Prompt' },
];

function getInitials(str: string): string {
  const parts = str.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function lastSeenDisplay(dateStr: string | null | undefined): { label: string; isOnline: boolean } {
  if (!dateStr) return { label: 'Never logged in', isOnline: false };
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 5 * 60 * 1000) return { label: 'Online', isOnline: true };
  return { label: timeAgo(dateStr), isOnline: false };
}

const StatusPill = ({ status }: { status: string }) => {
  const map: Record<string, { dot: string; text: string; label: string }> = {
    pending:  { dot: 'bg-amber-400',   text: 'text-amber-600 dark:text-amber-400',    label: 'Pending' },
    accepted: { dot: 'bg-emerald-400', text: 'text-emerald-600 dark:text-emerald-400', label: 'Active' },
    revoked:  { dot: 'bg-zinc-400',    text: 'text-zinc-500',                           label: 'Revoked' },
    rejected: { dot: 'bg-red-400',     text: 'text-red-600 dark:text-red-400',          label: 'Rejected' },
  };
  const s = map[status] ?? map.revoked;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[10px] font-semibold', s.text)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', s.dot)} />
      {s.label}
    </span>
  );
};

const TeamMembers = () => {
  const navigate = useNavigate();
  const { user, isAdmin, loading: pageLoading } = useTeamRole();

  const [invites, setInvites] = useState<Invite[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [inviteRole, setInviteRole] = useState('viewer');
  const [invitePerms, setInvitePerms] = useState<string[]>(['overview', 'messages']);
  const [inviteName, setInviteName] = useState('');
  const [isGeneratingInvite, setIsGeneratingInvite] = useState(false);
  const [lastInviteLink, setLastInviteLink] = useState('');
  const [formOpen, setFormOpen] = useState(false);

  const [dbConnections, setDbConnections] = useState<MainDbConnection[]>([]);
  const [activeDbId, setActiveDbId] = useState<string | null>(null);
  const [dbDeleteConfirmId, setDbDeleteConfirmId] = useState<string | null>(null);
  const [dbSetupStatus, setDbSetupStatus] = useState<Record<string, 'checking' | 'ok' | 'needed'>>({});

  useEffect(() => {
    const conns = getConnections();
    const active = getActiveConnection();
    setDbConnections(conns);
    setActiveDbId(active?.id || null);
  }, []);

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
    if (!pageLoading && isAdmin) loadInvites(user?.id || 'admin');
  }, [pageLoading, isAdmin, user?.id]);

  const knownSubmissions = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isAdmin || pageLoading) return;
    const effectiveUserId = user?.id || 'admin';
    const seed = () => {
      invites.forEach(inv => { if (inv.submitted_email) knownSubmissions.current.add(inv.id); });
    };
    seed();
    const poll = setInterval(async () => {
      const conn = getActiveConnection();
      let fresh: Invite[] = [];
      try {
        if (conn && conn.dbType !== 'supabase') {
          const { proxyListInvites: pli, buildCreds: bc } = await import('@/lib/memberAuthProxy');
          fresh = (await pli(bc(conn), effectiveUserId)) as unknown as Invite[];
        } else {
          const { data: rpcData, error: rpcErr } = await (supabase as any).rpc('list_team_invites');
          if (!rpcErr && rpcData) {
            fresh = rpcData as unknown as Invite[];
          } else {
            let q = supabase.from('team_invites').select('*').order('created_at', { ascending: false });
            if (effectiveUserId !== 'admin') q = (q as typeof q).eq('created_by', effectiveUserId) as typeof q;
            const { data } = await q;
            fresh = (data ?? []) as unknown as Invite[];
          }
        }
      } catch { return; }
      fresh.forEach(inv => {
        if (inv.submitted_email && !knownSubmissions.current.has(inv.id)) {
          knownSubmissions.current.add(inv.id);
          const memberName = inv.submitted_name || inv.submitted_email;
          toast.success(`📩 ${memberName} submitted a join request — review below`, { duration: 6000 });
        }
      });
      setInvites(fresh);
    }, 15000);
    return () => clearInterval(poll);
  }, [isAdmin, user?.id, pageLoading]);

  const loadInvites = async (userId: string) => {
    setInvitesLoading(true);
    try {
      const conn = getActiveConnection();
      if (conn && conn.dbType !== 'supabase') {
        const list = await proxyListInvites(buildCreds(conn), userId);
        setInvites(list as unknown as Invite[]);
        return;
      }
      const { data: rpcData, error: rpcErr } = await (supabase as any).rpc('list_team_invites');
      if (!rpcErr && rpcData) {
        setInvites(rpcData as unknown as Invite[]);
        return;
      }
      const isAdminNoUser = userId === 'admin';
      let query = supabase.from('team_invites').select('*').order('created_at', { ascending: false });
      if (!isAdminNoUser) query = (query as typeof query).eq('created_by', userId) as typeof query;
      const { data: d1, error: e1 } = await query;
      if (e1?.message?.includes('created_by') && !isAdminNoUser) {
        const { data: d2 } = await supabase.from('team_invites').select('*').filter('invited_by', 'eq', userId).order('created_at', { ascending: false });
        setInvites((d2 ?? []) as unknown as Invite[]);
      } else {
        setInvites((d1 ?? []) as unknown as Invite[]);
      }
    } finally {
      setInvitesLoading(false);
    }
  };

  const togglePerm = (key: string) =>
    setInvitePerms((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);

  const buildInviteLink = (token: string, memberName?: string) => {
    const base = `${window.location.origin}/invite/${token}`;
    const conn = getActiveConnection();
    let link = base;
    if (conn?.dbType === 'supabase' && conn.url && conn.anonKey) {
      const u = btoa(conn.url);
      const k = btoa(conn.anonKey);
      link = `${base}?u=${encodeURIComponent(u)}&k=${encodeURIComponent(k)}`;
      const stored = getStoredConnection();
      const tbl = stored?.table_name || '';
      if (tbl) link += `&t=${encodeURIComponent(btoa(tbl))}`;
    } else if (conn && conn.dbType !== 'supabase') {
      const enc = encodeNonSupabaseCreds(conn);
      link = `${base}?x=${encodeURIComponent(enc)}`;
    }
    if (memberName) link += `&n=${encodeURIComponent(btoa(memberName))}`;
    try {
      const platformRaw = localStorage.getItem(PLATFORM_CONNS_KEY);
      if (platformRaw && platformRaw !== '[]') link += `&p=${encodeURIComponent(btoa(platformRaw))}`;
    } catch { /* ignore */ }
    try {
      const n8nRaw = localStorage.getItem(N8N_SETTINGS_KEY);
      if (n8nRaw && n8nRaw !== 'null') link += `&q=${encodeURIComponent(btoa(n8nRaw))}`;
    } catch { /* ignore */ }
    return link;
  };

  const handleGenerateInvite = async () => {
    if (!user && !isAdmin) return;
    setIsGeneratingInvite(true);
    try {
      const perms = (inviteRole === 'admin' || inviteRole === 'sub-admin') ? PERMISSION_OPTIONS.map((p) => p.key) : invitePerms;
      const conn = getActiveConnection();
      let token = '';
      const createdBy = user?.id || null;

      if (!conn || conn.dbType === 'supabase') {
        const { data: rpcRow, error: rpcInsertErr } = await (supabase as any).rpc('create_team_invite', {
          p_email: inviteName.trim() || '',
          p_role: inviteRole,
          p_permissions: perms,
        });
        if (rpcInsertErr) {
          const { data, error } = await (supabase as any).from('team_invites').insert({
            created_by: createdBy ?? '',
            email: inviteName.trim() || '',
            role: inviteRole,
            permissions: perms,
          }).select().single();
          if (error) {
            if (error.message.includes('row-level security') || error.message.includes('RLS') || error.message.includes('policy')) {
              toast.error('RLS policy blocked the insert. Go to Account → Database Setup → Supabase tab, copy the SQL and run it in your Supabase SQL Editor, then try again.', { duration: 10000 });
            } else {
              toast.error('Failed to create invite: ' + error.message);
            }
            return;
          }
          token = data.token;
        } else {
          const row = Array.isArray(rpcRow) ? rpcRow[0] : rpcRow;
          token = row?.token ?? '';
        }
      } else {
        const creds = buildCreds(conn);
        try { await proxyInit(creds); } catch { /* table may already exist */ }
        const created = await proxyCreateInvite(creds, {
          email: inviteName.trim() || '',
          role: inviteRole,
          permissions: perms,
          created_by: createdBy ?? '',
        });
        token = created.token;
      }

      const link = buildInviteLink(token, inviteName.trim());
      setLastInviteLink(link);
      try { await navigator.clipboard.writeText(link); } catch { /* ignore */ }
      toast.success('Invite link generated & copied!');
      setInviteRole('viewer');
      setInvitePerms(['overview', 'messages']);
      setInviteName('');
      loadInvites(user?.id || 'admin');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create invite';
      if (msg.includes('row-level security') || msg.includes('RLS') || msg.includes('policy')) {
        toast.error('RLS policy blocked the insert. Go to Account → Database Setup, copy the SQL and run it in your Supabase SQL Editor, then try again.', { duration: 10000 });
      } else {
        toast.error(msg);
      }
    } finally { setIsGeneratingInvite(false); }
  };

  const getConnForInvites = () => getActiveConnection();

  const supabaseUpdateInvite = async (inviteId: string, status: string) => {
    const { error: rpcErr } = await (supabase as any).rpc('update_invite_status', { p_id: inviteId, p_status: status });
    if (!rpcErr) return;
    const { error } = await supabase.from('team_invites').update({ status }).eq('id', inviteId);
    if (error) throw new Error(error.message);
  };

  const handleAccept = async (inviteId: string) => {
    if (!user && !isAdmin) return;
    const conn = getConnForInvites();
    try {
      if (!conn || conn.dbType === 'supabase') await supabaseUpdateInvite(inviteId, 'accepted');
      else await proxyUpdateInvite(buildCreds(conn), inviteId, { status: 'accepted' });
      toast.success('Member approved — they can now sign in');
      loadInvites(user?.id || 'admin');
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to approve member'); }
  };

  const handleReject = async (inviteId: string) => {
    if (!user && !isAdmin) return;
    const conn = getConnForInvites();
    try {
      if (!conn || conn.dbType === 'supabase') await supabaseUpdateInvite(inviteId, 'rejected');
      else await proxyUpdateInvite(buildCreds(conn), inviteId, { status: 'rejected' });
      toast.success('Request rejected');
      loadInvites(user?.id || 'admin');
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to reject request'); }
  };

  const handleRevoke = async (inviteId: string) => {
    if (!user && !isAdmin) return;
    const conn = getConnForInvites();
    try {
      if (!conn || conn.dbType === 'supabase') await supabaseUpdateInvite(inviteId, 'revoked');
      else await proxyUpdateInvite(buildCreds(conn), inviteId, { status: 'revoked' });
      toast.success('Access revoked — member can no longer sign in');
      loadInvites(user?.id || 'admin');
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to revoke access'); }
  };

  const handleDelete = async (inviteId: string) => {
    if (!user && !isAdmin) return;
    const conn = getConnForInvites();
    try {
      if (!conn || conn.dbType === 'supabase') {
        const { error: rpcErr } = await (supabase as any).rpc('delete_team_invite', { p_id: inviteId });
        if (rpcErr) {
          const { error } = await supabase.from('team_invites').delete().eq('id', inviteId);
          if (error) throw new Error(error.message);
        }
      } else {
        await proxyDeleteInvite(buildCreds(conn), inviteId);
      }
      toast.success('Member removed');
      loadInvites(user?.id || 'admin');
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to delete member'); }
  };

  const copyLink = async (token: string, memberName?: string) => {
    const link = buildInviteLink(token, memberName);
    try { await navigator.clipboard.writeText(link); toast.success('Link copied!'); }
    catch { toast.error('Could not copy'); }
  };

  if (pageLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 size={22} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  const activeCount = invites.filter((i) => i.status === 'accepted').length;
  const pendingCount = invites.filter((i) => i.status === 'pending').length;

  return (
    <div className="min-h-screen bg-muted/20">

      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/90 backdrop-blur-md border-b border-border/50">
        <div className="max-w-2xl mx-auto px-4 h-13 flex items-center justify-between">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors font-medium py-3"
          >
            <ArrowLeft size={14} /> Dashboard
          </button>
          <span className="text-[11px] font-bold text-muted-foreground tracking-widest uppercase">Team Members</span>
          <div className="w-20" />
        </div>
      </div>

      {/* Content */}
      <div className="max-w-2xl mx-auto px-4 py-5 space-y-3">

        {/* Top bar: counts + invite button */}
        <div className="flex items-center justify-between px-0.5">
          <div className="flex items-center gap-2">
            {activeCount > 0 && (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
                {activeCount} active
              </span>
            )}
            {pendingCount > 0 && (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
                {pendingCount} pending
              </span>
            )}
            {activeCount === 0 && pendingCount === 0 && (
              <span className="text-xs text-muted-foreground">No members yet</span>
            )}
          </div>
          <button
            onClick={() => setFormOpen((v) => !v)}
            className={cn(
              'flex items-center gap-1.5 h-8 px-3 rounded-xl text-xs font-semibold transition-all',
              formOpen
                ? 'bg-muted text-muted-foreground'
                : 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm'
            )}
          >
            <UserPlus size={12} />
            {formOpen ? 'Cancel' : 'Invite member'}
          </button>
        </div>

        {/* Invite Form — collapsible */}
        {formOpen && (
          <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="p-5 space-y-4">

              {/* Name + Role side by side */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Name <span className="text-muted-foreground/40">(optional)</span></label>
                  <input
                    type="text"
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    placeholder="e.g. Rahim..."
                    className="w-full h-9 rounded-xl border border-border/60 bg-muted/30 px-3 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-colors"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Role</label>
                  <div className="relative">
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value)}
                      className="w-full appearance-none h-9 rounded-xl border border-border/60 bg-muted/30 px-3 pr-8 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-colors"
                    >
                      <option value="viewer">Viewer</option>
                      <option value="admin">Admin</option>
                      <option value="sub-admin">Sub-Admin (Own DB)</option>
                    </select>
                    <ChevronDown size={12} className="absolute right-2.5 top-3 text-muted-foreground pointer-events-none" />
                  </div>
                </div>
              </div>

              {/* Permissions */}
              {inviteRole === 'viewer' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-medium text-muted-foreground">Page access</label>
                    <span className="text-[10px] text-muted-foreground/40">· Settings is admin-only</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {PERMISSION_OPTIONS.map((opt) => {
                      const active = invitePerms.includes(opt.key);
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => togglePerm(opt.key)}
                          className={cn(
                            'flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-medium transition-all text-left',
                            active
                              ? 'bg-primary/10 border-primary/30 text-primary'
                              : 'bg-muted/20 border-border/50 text-muted-foreground hover:border-border hover:text-foreground hover:bg-muted/40'
                          )}
                        >
                          <span className={cn(
                            'w-3.5 h-3.5 rounded flex items-center justify-center flex-shrink-0 border transition-colors',
                            active ? 'bg-primary border-primary' : 'border-border/60'
                          )}>
                            {active && <Check size={8} className="text-primary-foreground" />}
                          </span>
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {inviteRole === 'admin' && (
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-primary/5 border border-primary/15">
                  <ShieldCheck size={13} className="text-primary flex-shrink-0" />
                  <p className="text-[11px] text-muted-foreground">Admin members have full access to all sections.</p>
                </div>
              )}

              {inviteRole === 'sub-admin' && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-violet-500/5 border border-violet-500/20">
                  <Database size={13} className="text-violet-600 dark:text-violet-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-[11px] font-semibold text-violet-700 dark:text-violet-400 mb-0.5">Sub-Admin — Own Database</p>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      This member will connect their <strong>own database</strong> after accepting. Completely separate from yours.
                    </p>
                  </div>
                </div>
              )}

              <button
                onClick={handleGenerateInvite}
                disabled={isGeneratingInvite}
                className="w-full h-9 rounded-xl bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-2 hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50 shadow-sm"
              >
                {isGeneratingInvite ? (
                  <><Loader2 size={14} className="animate-spin" /> Generating…</>
                ) : (
                  <><Link2 size={14} /> Generate Invite Link</>
                )}
              </button>

              {lastInviteLink && (
                <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/20 p-3 space-y-2">
                  <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse inline-block" />
                    Link ready — share with your team member
                  </p>
                  <div className="flex items-center gap-2 bg-background/80 rounded-lg border border-border/50 px-3 py-2">
                    <p className="text-[10px] text-muted-foreground font-mono flex-1 truncate">{lastInviteLink}</p>
                    <button
                      onClick={async () => {
                        try { await navigator.clipboard.writeText(lastInviteLink); toast.success('Copied!'); }
                        catch { toast.error('Could not copy'); }
                      }}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary text-primary-foreground text-[10px] font-semibold hover:bg-primary/90 transition-colors flex-shrink-0"
                    >
                      <Copy size={9} /> Copy
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Members List */}
        <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border/50 flex items-center justify-between">
            <p className="text-sm font-semibold">Members</p>
            {invites.length > 0 && (
              <span className="text-[10px] text-muted-foreground">{invites.length} total</span>
            )}
          </div>

          {invitesLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 size={16} className="animate-spin text-muted-foreground" />
            </div>
          ) : invites.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center px-6">
              <div className="w-11 h-11 rounded-2xl bg-muted flex items-center justify-center mb-3">
                <Users size={18} className="text-muted-foreground/40" />
              </div>
              <p className="text-sm font-medium text-foreground mb-1">No members yet</p>
              <p className="text-xs text-muted-foreground">Generate an invite link above to add team members</p>
            </div>
          ) : (
            <div className="divide-y divide-border/40">
              {invites.map((invite) => {
                const hasSubmission = !!invite.submitted_email;
                const isPending = invite.status === 'pending';
                const label = invite.submitted_name || invite.submitted_email || invite.email || `Link invite · ${invite.role}`;
                const avatarLabel = invite.submitted_name
                  ? getInitials(invite.submitted_name)
                  : invite.email && invite.email.trim()
                    ? getInitials(invite.email.split('@')[0])
                    : invite.role === 'admin' ? 'AD' : invite.role === 'sub-admin' ? 'SA' : 'VW';
                return (
                  <div key={invite.id}>
                    <div className="flex items-center gap-3 px-5 py-3.5 hover:bg-muted/20 transition-colors">
                      {/* Avatar */}
                      <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-[10px] font-bold text-primary flex-shrink-0 border border-primary/10">
                        {avatarLabel}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-foreground truncate">{label}</p>
                          <span className={cn(
                            'text-[9px] font-bold px-1.5 py-0.5 rounded-md flex-shrink-0',
                            invite.role === 'admin'
                              ? 'bg-primary/10 text-primary'
                              : invite.role === 'sub-admin'
                                ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400'
                                : 'bg-muted text-muted-foreground'
                          )}>
                            {invite.role === 'sub-admin' ? 'OWN DB' : invite.role.toUpperCase()}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <StatusPill status={invite.status} />
                          {isPending && hasSubmission && (
                            <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">
                              Credentials submitted — awaiting approval
                            </span>
                          )}
                          {isPending && !hasSubmission && (
                            <span className="text-[10px] text-muted-foreground/60">
                              Waiting for member to fill form
                            </span>
                          )}
                          {!isPending && invite.status !== 'revoked' && invite.status !== 'rejected' && invite.role === 'sub-admin' && (
                            <span className="text-[10px] text-violet-600/60 dark:text-violet-400/60 truncate flex items-center gap-1">
                              <Database size={9} /> Connects own database
                            </span>
                          )}
                          {!isPending && invite.status !== 'revoked' && invite.status !== 'rejected' && invite.role !== 'sub-admin' && invite.permissions?.length > 0 && (
                            <span className="text-[10px] text-muted-foreground/50 truncate">
                              {invite.permissions.slice(0, 3).join(', ')}{invite.permissions.length > 3 ? ` +${invite.permissions.length - 3}` : ''}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Right side: time info + ⋯ menu */}
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {invite.status === 'accepted' ? (() => {
                          const seen = lastSeenDisplay(invite.last_login_at);
                          return (
                            <span className={`text-[10px] hidden sm:flex items-center gap-1 ${seen.isOnline ? 'text-emerald-500 font-semibold' : invite.last_login_at ? 'text-muted-foreground/50' : 'text-muted-foreground/30'}`}>
                              {seen.isOnline
                                ? <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
                                : <Clock size={9} />
                              }
                              {seen.label}
                            </span>
                          );
                        })() : (
                          <span className="text-[10px] text-muted-foreground/40 hidden sm:flex items-center gap-0.5">
                            <Clock size={9} /> {timeAgo(invite.created_at)}
                          </span>
                        )}

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                              title="Actions"
                            >
                              <MoreHorizontal size={14} />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44 text-sm">
                            {isPending && (
                              <DropdownMenuItem
                                onClick={() => copyLink(invite.token, invite.email || undefined)}
                                className="gap-2 cursor-pointer"
                              >
                                <Copy size={13} className="text-muted-foreground" />
                                Copy invite link
                              </DropdownMenuItem>
                            )}
                            {isPending && hasSubmission && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() => handleAccept(invite.id)}
                                  className="gap-2 cursor-pointer text-emerald-600 dark:text-emerald-400 focus:text-emerald-600 dark:focus:text-emerald-400"
                                >
                                  <UserCheck size={13} />
                                  Accept member
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => handleReject(invite.id)}
                                  className="gap-2 cursor-pointer text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400"
                                >
                                  <UserX size={13} />
                                  Reject request
                                </DropdownMenuItem>
                              </>
                            )}
                            {invite.status === 'accepted' && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() => handleRevoke(invite.id)}
                                  className="gap-2 cursor-pointer text-amber-600 dark:text-amber-400 focus:text-amber-600 dark:focus:text-amber-400"
                                >
                                  <ShieldOff size={13} />
                                  Revoke access
                                </DropdownMenuItem>
                              </>
                            )}
                            {(invite.status === 'revoked' || invite.status === 'rejected') && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() => handleDelete(invite.id)}
                                  className="gap-2 cursor-pointer text-destructive focus:text-destructive"
                                >
                                  <Trash2 size={13} />
                                  Remove member
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                    {/* Submission detail row */}
                    {hasSubmission && isPending && (
                      <div className="px-5 pb-3 -mt-1 ml-11">
                        <div className="rounded-lg bg-emerald-500/5 border border-emerald-500/15 px-3 py-2 text-[11px] text-muted-foreground space-y-0.5">
                          {invite.submitted_name && (
                            <p><span className="font-semibold text-foreground">Name:</span> {invite.submitted_name}</p>
                          )}
                          {invite.submitted_email && (
                            <p><span className="font-semibold text-foreground">Email:</span> {invite.submitted_email}</p>
                          )}
                          {invite.submitted_at && (
                            <p><span className="font-semibold text-foreground">Submitted:</span> {timeAgo(invite.submitted_at)}</p>
                          )}
                          <p className="text-emerald-600 dark:text-emerald-400 font-semibold pt-0.5">✓ Click Accept above to let them sign in</p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

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

export default TeamMembers;
