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
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  getActiveConnection,
} from '@/lib/db-config';
import { getStoredConnection } from '@/lib/externalDb';
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
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">

        {/* Section title + counts */}
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

        {/* Invite Form Card */}
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
              />
            </div>

            {/* Role selector */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Role</label>
              <div className="relative">
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="w-full appearance-none h-9 rounded-xl border border-border/60 bg-muted/30 px-3 pr-8 py-1 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-colors"
                >
                  <option value="viewer">Viewer</option>
                  <option value="admin">Admin</option>
                  <option value="sub-admin">Sub-Admin (Own DB)</option>
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

            {inviteRole === 'sub-admin' && (
              <div className="space-y-2 px-3 py-2.5 rounded-xl bg-violet-500/5 border border-violet-500/20">
                <div className="flex items-center gap-2">
                  <Database size={13} className="text-violet-600 dark:text-violet-400 flex-shrink-0" />
                  <p className="text-[11px] font-semibold text-violet-700 dark:text-violet-400">Sub-Admin — Own Database</p>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  This member will connect their <strong>own database</strong> after accepting the invite. They'll have full access to their own data — completely separate from yours.
                </p>
              </div>
            )}

            <button
              onClick={handleGenerateInvite}
              disabled={isGeneratingInvite}
              className="w-full h-10 rounded-xl bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-2 hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50 shadow-sm"
            >
              {isGeneratingInvite ? (
                <><Loader2 size={14} className="animate-spin" /> Generating…</>
              ) : (
                <><Link2 size={14} /> Generate Invite Link</>
              )}
            </button>

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

      </div>
    </div>
  );
};

export default TeamMembers;
