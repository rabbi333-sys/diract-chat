import { useEffect, useState } from 'react';
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

type Invite = {
  id: string;
  email: string;
  role: string;
  permissions: string[];
  token: string;
  status: string;
  accepted_user_id: string | null;
  created_at: string;
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
    pending:  { dot: 'bg-amber-400',   text: 'text-amber-600 dark:text-amber-400',   label: 'Pending' },
    accepted: { dot: 'bg-emerald-400', text: 'text-emerald-600 dark:text-emerald-400', label: 'Active' },
    revoked:  { dot: 'bg-zinc-400',    text: 'text-zinc-500',                          label: 'Revoked' },
  };
  const s = map[status] ?? map.revoked;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[10px] font-semibold', s.text)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', s.dot)} />
      {s.label}
    </span>
  );
};

const INVITE_FIX_SQL = `ALTER TABLE public.team_invites
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS permissions text[] DEFAULT '{}' NOT NULL,
  ADD COLUMN IF NOT EXISTS token uuid DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending' NOT NULL,
  ADD COLUMN IF NOT EXISTS accepted_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

UPDATE public.team_invites SET created_by = invited_by WHERE created_by IS NULL;
ALTER TABLE public.team_invites ALTER COLUMN created_by SET NOT NULL;
ALTER TABLE public.team_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage invites" ON public.team_invites;
CREATE POLICY "Admins can manage invites" ON public.team_invites
  USING (auth.uid() = created_by);

CREATE OR REPLACE FUNCTION public.get_invite_by_token(p_token uuid)
RETURNS TABLE (id uuid, email text, role text, permissions text[], status text, created_by uuid, invited_by uuid)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id, email, role, permissions, status, created_by, invited_by
  FROM public.team_invites WHERE token = p_token AND status = 'pending';
$$;`;

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
  const [isGeneratingInvite, setIsGeneratingInvite] = useState(false);
  const [lastInviteLink, setLastInviteLink] = useState('');
  const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [showInviteSql, setShowInviteSql] = useState(false);

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

  useEffect(() => {
    if (user?.user_metadata?.avatar_url) setAvatarUrl(user.user_metadata.avatar_url);
  }, [user]);

  const loadInvites = async (userId: string) => {
    setInvitesLoading(true);
    try {
      let { data, error } = await supabase.from('team_invites').select('*').eq('created_by', userId).order('created_at', { ascending: false });
      if (error?.message?.includes('created_by')) {
        ({ data, error } = await supabase.from('team_invites').select('*').eq('invited_by', userId).order('created_at', { ascending: false }));
      }
      setInvites(data ?? []);
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
    clearGuestSession();
    await supabase.auth.signOut();
    navigate('/');
  };

  const togglePerm = (key: string) =>
    setInvitePerms((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);

  const buildInviteLink = (token: string) => {
    const base = `${window.location.origin}/invite/${token}`;
    const conn = getActiveConnection();
    if (conn?.url && conn?.anonKey) {
      const u = btoa(conn.url);
      const k = btoa(conn.anonKey);
      return `${base}?u=${encodeURIComponent(u)}&k=${encodeURIComponent(k)}`;
    }
    return base;
  };

  const handleGenerateInvite = async () => {
    if (!user) return;
    setIsGeneratingInvite(true);
    try {
      const perms = inviteRole === 'admin' ? PERMISSION_OPTIONS.map((p) => p.key) : invitePerms;
      const { data, error } = await supabase.from('team_invites').insert({
        created_by: user.id,
        email: '',
        role: inviteRole,
        permissions: perms,
      }).select().single();
      if (error) {
        if (error.message.includes('created_by') || error.message.includes('schema cache')) {
          setShowInviteSql(true);
          toast.error('Database needs updating — see SQL below');
        } else {
          toast.error('Failed to create invite: ' + error.message);
        }
        return;
      }
      const link = buildInviteLink(data.token);
      setLastInviteLink(link);
      try { await navigator.clipboard.writeText(link); } catch { /* ignore */ }
      toast.success('Invite link generated & copied!');
      setInviteRole('viewer');
      setInvitePerms(['overview', 'messages']);
      loadInvites(user.id);
    } finally { setIsGeneratingInvite(false); }
  };

  const handleRevoke = async (inviteId: string) => {
    if (!user) return;
    const { error } = await supabase.from('team_invites').update({ status: 'revoked' }).eq('id', inviteId);
    setRevokeConfirmId(null);
    if (error) { toast.error('Failed to revoke access'); }
    else { toast.success('Access revoked'); loadInvites(user.id); }
  };

  const handleDelete = async (inviteId: string) => {
    if (!user) return;
    const { error } = await supabase.from('team_invites').delete().eq('id', inviteId);
    setDeleteConfirmId(null);
    if (error) { toast.error('Failed to delete member'); }
    else { toast.success('Member removed'); loadInvites(user.id); }
  };

  const copyLink = async (token: string) => {
    const link = buildInviteLink(token);
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
                    <p className="text-[10px] text-muted-foreground/60">The person signs up using this link to get team access.</p>
                  </div>
                )}
              </div>
            </div>

            {/* Invite DB setup SQL panel */}
            {showInviteSql && (
              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-5 space-y-3" data-testid="panel-invite-sql">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={13} className="text-amber-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">Database needs a one-time update</p>
                    <p className="text-xs text-amber-600/80 mt-0.5">Go to <strong>Supabase → SQL Editor</strong> and run:</p>
                  </div>
                </div>
                <SqlCopyBlock sql={INVITE_FIX_SQL} />
                <p className="text-[11px] text-amber-600/70">After running, refresh the page and try again.</p>
                <button onClick={() => setShowInviteSql(false)} className="text-[11px] text-muted-foreground hover:text-foreground underline">Dismiss</button>
              </div>
            )}

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
                    const label = invite.email && invite.email.trim()
                      ? invite.email
                      : `Link invite · ${invite.role}`;
                    const avatarLabel = invite.email && invite.email.trim()
                      ? getInitials(invite.email.split('@')[0])
                      : invite.role === 'admin' ? 'AD' : 'VW';
                    return (
                      <div key={invite.id} className="flex items-center gap-3 px-5 py-3.5 hover:bg-muted/20 transition-colors" data-testid={`member-row-${invite.id}`}>
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
                            {invite.status !== 'revoked' && invite.permissions?.length > 0 && (
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

                          {invite.status === 'pending' && (
                            <button
                              onClick={() => copyLink(invite.token)}
                              className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                              title="Copy invite link"
                              data-testid={`button-copy-link-${invite.id}`}
                            >
                              <Copy size={12} />
                            </button>
                          )}

                          {invite.status === 'pending' && (
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
                                title="Revoke"
                                data-testid={`button-revoke-${invite.id}`}
                              >
                                <X size={12} />
                              </button>
                            )
                          )}

                          {(invite.status === 'revoked' || invite.status === 'accepted') && (
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


      </div>
    </div>
  );
};

export default Profile;
