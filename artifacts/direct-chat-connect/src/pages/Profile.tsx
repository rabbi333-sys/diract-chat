import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useTeamRole } from '@/hooks/useTeamRole';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  ArrowLeft, LogOut, Pencil, Check, X, UserPlus, Copy, Trash2,
  ChevronDown, ShieldCheck, Eye, Loader2, Link2, Camera, AlertTriangle,
  ClipboardCopy, Users, Database, Plus, Zap, ChevronRight, Clock,
} from 'lucide-react';
import {
  getConnections, getActiveConnection, setActiveConnection,
  deleteConnection, MAX_CONNECTIONS, MainDbConnection,
  DB_TYPES, getConnectionDisplayUrl,
} from '@/lib/db-config';
import { clearGuestSession } from '@/lib/guestSession';
import { getStoredConnection } from '@/lib/externalDb';
import { signOutMember, hasMemberSetup } from '@/lib/memberAuth';
import {
  buildCreds, encodeNonSupabaseCreds,
  proxyInit, proxyListInvites, proxyCreateInvite,
  proxyUpdateInvite, proxyDeleteInvite,
} from '@/lib/memberAuthProxy';

const PLATFORM_CONNS_KEY = 'chat_monitor_platform_connections';
const N8N_SETTINGS_KEY = 'chat_monitor_n8n_settings';

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
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
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

const INVITE_FIX_SQL = `-- Step 1: Add base invite columns
ALTER TABLE public.team_invites
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS permissions text[] DEFAULT '{}' NOT NULL,
  ADD COLUMN IF NOT EXISTS token uuid DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending' NOT NULL,
  ADD COLUMN IF NOT EXISTS accepted_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Step 2: Add member-submission columns (approval-based auth)
ALTER TABLE public.team_invites
  ADD COLUMN IF NOT EXISTS submitted_name text,
  ADD COLUMN IF NOT EXISTS submitted_email text,
  ADD COLUMN IF NOT EXISTS submitted_password_hash text,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

UPDATE public.team_invites SET created_by = invited_by WHERE created_by IS NULL;
ALTER TABLE public.team_invites ALTER COLUMN created_by SET NOT NULL;
ALTER TABLE public.team_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage invites" ON public.team_invites;
CREATE POLICY "Admins can manage invites" ON public.team_invites
  USING (auth.uid() = created_by);

-- Step 3: RPC for reading a pending invite by token (admin-level, SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.get_invite_by_token(p_token uuid)
RETURNS TABLE (id uuid, email text, role text, permissions text[], status text, created_by uuid, invited_by uuid)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id, email, role, permissions, status, created_by, invited_by
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
BEGIN
  RETURN QUERY
  SELECT t.id, t.role, t.permissions, t.submitted_name, t.submitted_email
  FROM public.team_invites t
  WHERE t.submitted_email = lower(trim(p_email))
    AND t.submitted_password_hash = p_password_hash
    AND t.status = 'accepted';
END;
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
const Profile = () => {
  const navigate = useNavigate();
  const { user, isAdmin, displayName, initials, loading: pageLoading } = useTeamRole();

  const [editName, setEditName] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [isSavingName, setIsSavingName] = useState(false);

  const [invites, setInvites] = useState<Invite[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(false);

  const [inviteRole, setInviteRole] = useState('viewer');
  const [invitePerms, setInvitePerms] = useState<string[]>(['overview', 'messages']);
  const [inviteName, setInviteName] = useState('');
  const [isGeneratingInvite, setIsGeneratingInvite] = useState(false);
  const [lastInviteLink, setLastInviteLink] = useState('');
  const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [dbSetupStatus, setDbSetupStatus] = useState<Record<string, 'checking' | 'ok' | 'needed'>>({});

  const [avatarUrl, setAvatarUrl] = useState('');
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);

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

  useEffect(() => {
    if (!pageLoading && isAdmin && user) loadInvites(user.id);
  }, [pageLoading, isAdmin, user?.id]);

  // ── Polling: auto-refresh invites & notify admin when member submits ────────
  const knownSubmissions = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isAdmin || !user || pageLoading) return;
    // Seed known submissions from initial load so we don't fire on mount
    const seed = () => {
      invites.forEach(inv => {
        if (inv.submitted_email) knownSubmissions.current.add(inv.id);
      });
    };
    seed();
    const poll = setInterval(async () => {
      if (!user) return;
      // Silently reload — don't touch invitesLoading state
      const conn = getActiveConnection();
      let fresh: Invite[] = [];
      try {
        if (conn && conn.dbType !== 'supabase') {
          const { proxyListInvites: pli, buildCreds: bc } = await import('@/lib/memberAuthProxy');
          fresh = (await pli(bc(conn), user.id)) as unknown as Invite[];
        } else {
          const { data } = await supabase
            .from('team_invites')
            .select('*')
            .eq('created_by', user.id)
            .order('created_at', { ascending: false });
          fresh = (data ?? []) as unknown as Invite[];
        }
      } catch { return; }

      // Detect newly submitted invites
      fresh.forEach(inv => {
        if (inv.submitted_email && !knownSubmissions.current.has(inv.id)) {
          knownSubmissions.current.add(inv.id);
          const memberName = inv.submitted_name || inv.submitted_email;
          toast.success(`📩 ${memberName} submitted a join request — review below`, {
            duration: 6000,
          });
        }
      });

      setInvites(fresh);
    }, 15000); // poll every 15 s

    return () => clearInterval(poll);
  }, [isAdmin, user?.id, pageLoading]);

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
    if (user?.user_metadata?.avatar_url) setAvatarUrl(user.user_metadata.avatar_url);
  }, [user]);

  const loadInvites = async (userId: string) => {
    setInvitesLoading(true);
    try {
      const conn = getActiveConnection();
      if (conn && conn.dbType !== 'supabase') {
        // Non-Supabase: use API server proxy
        const list = await proxyListInvites(buildCreds(conn), userId);
        setInvites(list as unknown as Invite[]);
        return;
      }

      // Supabase path
      const { data: d1, error: e1 } = await supabase
        .from('team_invites')
        .select('*')
        .eq('created_by', userId)
        .order('created_at', { ascending: false });

      if (e1?.message?.includes('created_by')) {
        const { data: d2 } = await supabase
          .from('team_invites')
          .select('*')
          .filter('invited_by', 'eq', userId)
          .order('created_at', { ascending: false });
        setInvites((d2 ?? []) as unknown as Invite[]);
      } else {
        setInvites((d1 ?? []) as unknown as Invite[]);
      }
    } finally {
      setInvitesLoading(false);
    }
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
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
      const { error } = await supabase.auth.updateUser({ data: { avatar_url: dataUrl } });
      if (error) { toast.error('Failed to save avatar'); return; }
      setAvatarUrl(dataUrl);
      toast.success('Profile photo updated!');
    } catch {
      toast.error('Could not process image');
    } finally {
      setIsUploadingAvatar(false);
      e.target.value = '';
    }
  };

  const handleSaveName = async () => {
    if (!user || !editName.trim()) return;
    setIsSavingName(true);
    try {
      const { error } = await supabase.auth.updateUser({ data: { display_name: editName.trim() } });
      if (error) { toast.error('Failed to update name'); }
      else { toast.success('Name updated'); setIsEditingName(false); }
    } finally { setIsSavingName(false); }
  };

  const handleSignOut = async () => {
    if (hasMemberSetup()) {
      await signOutMember();
      window.location.href = '/member-login';
    } else {
      clearGuestSession();
      await supabase.auth.signOut();
      navigate('/');
    }
  };

  const togglePerm = (key: string) =>
    setInvitePerms((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);

  const buildInviteLink = (token: string, memberName?: string) => {
    const base = `${window.location.origin}/invite/${token}`;
    const conn = getActiveConnection();
    let link = base;

    if (conn?.dbType === 'supabase' && conn.url && conn.anonKey) {
      // Supabase: embed URL + anon key directly
      const u = btoa(conn.url);
      const k = btoa(conn.anonKey);
      link = `${base}?u=${encodeURIComponent(u)}&k=${encodeURIComponent(k)}`;
      const stored = getStoredConnection();
      const tbl = stored?.table_name || '';
      if (tbl) link += `&t=${encodeURIComponent(btoa(tbl))}`;
    } else if (conn && conn.dbType !== 'supabase') {
      // Non-Supabase: encode DB credentials as a single param
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
    if (!user) return;
    setIsGeneratingInvite(true);
    try {
      const perms = inviteRole === 'admin' ? PERMISSION_OPTIONS.map((p) => p.key) : invitePerms;
      const conn = getActiveConnection();
      let token = '';

      if (!conn || conn.dbType === 'supabase') {
        // Supabase path
        const { data, error } = await supabase.from('team_invites').insert({
          created_by: user.id,
          email: inviteName.trim() || '',
          role: inviteRole,
          permissions: perms,
        }).select().single();
        if (error) {
          if (error.message.includes('created_by') || error.message.includes('schema cache')) {
            toast.error('Database needs updating — see Database Setup at the bottom of this page');
          } else {
            toast.error('Failed to create invite: ' + error.message);
          }
          return;
        }
        token = data.token;
      } else {
        // Non-Supabase path — via API server
        const creds = buildCreds(conn);
        try {
          await proxyInit(creds);
        } catch { /* table may already exist */ }
        const created = await proxyCreateInvite(creds, {
          email: inviteName.trim() || '',
          role: inviteRole,
          permissions: perms,
          created_by: user.id,
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
      loadInvites(user.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create invite');
    } finally { setIsGeneratingInvite(false); }
  };

  const getConnForInvites = () => getActiveConnection();

  const handleAccept = async (inviteId: string) => {
    if (!user) return;
    const conn = getConnForInvites();
    try {
      if (!conn || conn.dbType === 'supabase') {
        const { error } = await supabase.from('team_invites').update({ status: 'accepted' }).eq('id', inviteId);
        if (error) throw new Error(error.message);
      } else {
        await proxyUpdateInvite(buildCreds(conn), inviteId, { status: 'accepted' });
      }
      toast.success('Member approved — they can now sign in');
      loadInvites(user.id);
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to approve member'); }
  };

  const handleReject = async (inviteId: string) => {
    if (!user) return;
    const conn = getConnForInvites();
    try {
      if (!conn || conn.dbType === 'supabase') {
        const { error } = await supabase.from('team_invites').update({ status: 'rejected' }).eq('id', inviteId);
        if (error) throw new Error(error.message);
      } else {
        await proxyUpdateInvite(buildCreds(conn), inviteId, { status: 'rejected' });
      }
      toast.success('Request rejected');
      loadInvites(user.id);
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to reject request'); }
  };

  const handleRevoke = async (inviteId: string) => {
    if (!user) return;
    const conn = getConnForInvites();
    setRevokeConfirmId(null);
    try {
      if (!conn || conn.dbType === 'supabase') {
        const { error } = await supabase.from('team_invites').update({ status: 'revoked' }).eq('id', inviteId);
        if (error) throw new Error(error.message);
      } else {
        await proxyUpdateInvite(buildCreds(conn), inviteId, { status: 'revoked' });
      }
      toast.success('Access revoked — member can no longer sign in');
      loadInvites(user.id);
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to revoke access'); }
  };

  const handleDelete = async (inviteId: string) => {
    if (!user) return;
    const conn = getConnForInvites();
    setDeleteConfirmId(null);
    try {
      if (!conn || conn.dbType === 'supabase') {
        const { error } = await supabase.from('team_invites').delete().eq('id', inviteId);
        if (error) throw new Error(error.message);
      } else {
        await proxyDeleteInvite(buildCreds(conn), inviteId);
      }
      toast.success('Member removed');
      loadInvites(user.id);
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

        {/* ── Team Members (admin only) ── */}
        {isAdmin && (
          <div className="space-y-3">

            {/* Section header */}
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <Users size={13} className="text-muted-foreground" />
                <h2 className="text-sm font-semibold text-foreground">Team Members</h2>
              </div>
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
              </div>
            </div>

            {/* ── Invite Form Card ── */}
            <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
              <div className="px-5 py-3.5 border-b border-border/50 flex items-center gap-2.5">
                <div className="w-6 h-6 rounded-lg bg-primary/10 flex items-center justify-center">
                  <UserPlus size={12} className="text-primary" />
                </div>
                <p className="text-sm font-semibold">Invite a Member</p>
              </div>

              <div className="p-5 space-y-4">
                {/* Member Name */}
                <div className="space-y-1.5">
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Member Name <span className="normal-case text-muted-foreground/40">(optional)</span></label>
                  <input
                    type="text"
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    placeholder="e.g. Rahim, Support Team..."
                    className="w-full h-9 rounded-xl border border-border/60 bg-muted/30 px-3 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-colors"
                    data-testid="input-invite-name"
                  />
                </div>

                {/* Role selector */}
                <div className="space-y-1.5">
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Role</label>
                  <div className="relative">
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value)}
                      data-testid="select-invite-role"
                      className="w-full appearance-none h-9 rounded-xl border border-border/60 bg-muted/30 px-3 pr-8 py-1 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-colors"
                    >
                      <option value="viewer">Viewer</option>
                      <option value="admin">Admin</option>
                    </select>
                    <ChevronDown size={12} className="absolute right-2.5 top-2.5 text-muted-foreground pointer-events-none" />
                  </div>
                </div>

                {/* Permissions */}
                {inviteRole === 'viewer' && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Page Access</label>
                      <span className="text-[10px] text-muted-foreground/50">Settings is admin-only</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {PERMISSION_OPTIONS.map((opt) => {
                        const active = invitePerms.includes(opt.key);
                        return (
                          <button
                            key={opt.key}
                            type="button"
                            onClick={() => togglePerm(opt.key)}
                            className={cn(
                              'flex items-center justify-center gap-1.5 px-2 py-2 rounded-xl border text-xs font-medium transition-all',
                              active
                                ? 'bg-primary/10 border-primary/30 text-primary'
                                : 'bg-muted/20 border-border/50 text-muted-foreground hover:border-border hover:text-foreground hover:bg-muted/40'
                            )}
                            data-testid={`checkbox-perm-${opt.key}`}
                          >
                            {active && <Check size={9} className="flex-shrink-0" />}
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

                {/* Generate button */}
                <button
                  onClick={handleGenerateInvite}
                  disabled={isGeneratingInvite}
                  data-testid="button-send-invite"
                  className="w-full h-10 rounded-xl bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-2 hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50 shadow-sm"
                >
                  {isGeneratingInvite ? (
                    <><Loader2 size={14} className="animate-spin" /> Generating…</>
                  ) : (
                    <><Link2 size={14} /> Generate Invite Link</>
                  )}
                </button>

                {/* Invite link result */}
                {lastInviteLink && (
                  <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/20 p-3.5 space-y-2.5">
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">Invite link ready — share this!</p>
                    </div>
                    <div className="flex items-center gap-2 bg-background/80 rounded-lg border border-border/50 px-3 py-2">
                      <p className="text-[10px] text-muted-foreground font-mono flex-1 truncate">{lastInviteLink}</p>
                      <button
                        onClick={async () => {
                          try { await navigator.clipboard.writeText(lastInviteLink); toast.success('Copied!'); }
                          catch { toast.error('Could not copy'); }
                        }}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary text-primary-foreground text-[10px] font-semibold hover:bg-primary/90 transition-colors flex-shrink-0"
                        data-testid="button-copy-invite-link"
                      >
                        <Copy size={9} /> Copy
                      </button>
                    </div>
                    <p className="text-[10px] text-emerald-600 dark:text-emerald-400/70">
                      ✓ Share this link with your team member. They'll submit their details for your approval.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* ── Members List ── */}
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
                        : invite.role === 'admin' ? 'AD' : 'VW';
                    return (
                      <div key={invite.id} data-testid={`member-row-${invite.id}`}>
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
                                  : 'bg-muted text-muted-foreground'
                              )}>
                                {invite.role.toUpperCase()}
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
                              {!isPending && invite.status !== 'revoked' && invite.status !== 'rejected' && invite.permissions?.length > 0 && (
                                <span className="text-[10px] text-muted-foreground/50 truncate">
                                  {invite.permissions.slice(0, 3).join(', ')}{invite.permissions.length > 3 ? ` +${invite.permissions.length - 3}` : ''}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <span className="text-[10px] text-muted-foreground/40 hidden sm:flex items-center gap-0.5 mr-1">
                              <Clock size={9} /> {timeAgo(invite.created_at)}
                            </span>

                            {/* ALL pending: copy link button */}
                            {isPending && (
                              <button
                                onClick={() => copyLink(invite.token, invite.email || undefined)}
                                className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                                title="Copy invite link"
                                data-testid={`button-copy-link-${invite.id}`}
                              >
                                <Copy size={12} />
                              </button>
                            )}

                            {/* Only when member has submitted credentials: Accept ✓ / Reject ✗ */}
                            {isPending && hasSubmission && (
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => handleAccept(invite.id)}
                                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500 hover:text-white transition-colors border border-emerald-500/20"
                                  title="Approve member"
                                  data-testid={`button-accept-${invite.id}`}
                                >
                                  <Check size={11} /> Accept
                                </button>
                                <button
                                  onClick={() => handleReject(invite.id)}
                                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500 hover:text-white transition-colors border border-red-500/20"
                                  title="Reject request"
                                  data-testid={`button-reject-${invite.id}`}
                                >
                                  <X size={11} /> Reject
                                </button>
                              </div>
                            )}

                            {/* Accepted: revoke */}
                            {invite.status === 'accepted' && (
                              revokeConfirmId === invite.id ? (
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => handleRevoke(invite.id)}
                                    className="px-2 py-1 rounded-lg text-[10px] font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-colors"
                                    data-testid={`button-revoke-confirm-${invite.id}`}
                                  >Revoke</button>
                                  <button
                                    onClick={() => setRevokeConfirmId(null)}
                                    className="px-2 py-1 rounded-lg text-[10px] font-medium bg-muted text-muted-foreground hover:text-foreground transition-colors"
                                  >Cancel</button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setRevokeConfirmId(invite.id)}
                                  className="p-1.5 rounded-lg hover:bg-amber-500/10 text-muted-foreground hover:text-amber-600 transition-colors"
                                  title="Revoke access"
                                  data-testid={`button-revoke-${invite.id}`}
                                >
                                  <X size={12} />
                                </button>
                              )
                            )}

                            {/* Revoked/rejected: delete */}
                            {(invite.status === 'revoked' || invite.status === 'rejected') && (
                              deleteConfirmId === invite.id ? (
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => handleDelete(invite.id)}
                                    className="px-2 py-1 rounded-lg text-[10px] font-semibold bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
                                    data-testid={`button-delete-confirm-${invite.id}`}
                                  >Delete</button>
                                  <button
                                    onClick={() => setDeleteConfirmId(null)}
                                    className="px-2 py-1 rounded-lg text-[10px] font-medium bg-muted text-muted-foreground hover:text-foreground transition-colors"
                                  >Cancel</button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setDeleteConfirmId(invite.id)}
                                  className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                                  title="Remove"
                                  data-testid={`button-delete-${invite.id}`}
                                >
                                  <Trash2 size={12} />
                                </button>
                              )
                            )}
                          </div>
                        </div>

                        {/* Submission detail row — shows email/name when member has submitted */}
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
