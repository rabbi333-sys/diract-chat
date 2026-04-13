import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useTeamRole } from '@/hooks/useTeamRole';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import {
  ArrowLeft,
  LogOut,
  Pencil,
  Check,
  X,
  ShieldCheck,
  Eye,
  Loader2,
  Camera,
  KeyRound,
  Mail,
  LockKeyhole,
  Save,
  UserRound,
  BadgeCheck,
} from 'lucide-react';
import { clearGuestSession } from '@/lib/guestSession';
import { signOutMember, hasMemberSetup } from '@/lib/memberAuth';
import { clearAdminSession, getAdminEmail, updateAdminCredentials, hashPassword, verifyAdminCredentials, setAdminDisplayName, getAdminAvatarUrl, setAdminAvatarUrl } from '@/lib/adminAuth';

const Profile = () => {
  const navigate = useNavigate();
  const { user, isAdmin, displayName, initials, loading: pageLoading } = useTeamRole();

  const [editName, setEditName] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [isSavingName, setIsSavingName] = useState(false);

  const [avatarUrl, setAvatarUrl] = useState('');
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);

  const [credEmail, setCredEmail] = useState(() => getAdminEmail());
  const [credPassword, setCredPassword] = useState('');
  const [credConfirm, setCredConfirm] = useState('');
  const [credCurrentPw, setCredCurrentPw] = useState('');
  const [credSaving, setCredSaving] = useState(false);
  const [credError, setCredError] = useState('');
  const [credSuccess, setCredSuccess] = useState(false);

  useEffect(() => {
    if (displayName && !isEditingName) setEditName(displayName);
  }, [displayName]);

  useEffect(() => {
    if (user?.user_metadata?.avatar_url) {
      setAvatarUrl(user.user_metadata.avatar_url);
    } else if (isAdmin && !user) {
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
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 size={22} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.12),transparent_32%),linear-gradient(180deg,hsl(var(--background)),hsl(var(--muted)/0.35))]">
      <div className="sticky top-0 z-20 border-b border-border/60 bg-background/85 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4">
          <button
            onClick={() => navigate('/')}
            className="group inline-flex items-center gap-2 rounded-full border border-border/70 bg-card/85 px-3.5 py-2 text-sm font-semibold text-muted-foreground shadow-sm transition-all hover:-translate-x-0.5 hover:border-primary/30 hover:bg-primary/5 hover:text-foreground"
            data-testid="button-back-dashboard"
          >
            <ArrowLeft size={15} className="transition-transform group-hover:-translate-x-0.5" />
            Dashboard
          </button>
          <div className="text-center">
            <p className="text-[10px] font-black uppercase tracking-[0.32em] text-primary/80">Account</p>
            <p className="hidden text-xs font-medium text-muted-foreground sm:block">Profile, access and login security</p>
          </div>
          <button
            onClick={handleSignOut}
            className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card/85 px-3.5 py-2 text-xs font-bold text-muted-foreground shadow-sm transition-all hover:border-destructive/30 hover:bg-destructive/5 hover:text-destructive"
            data-testid="button-sign-out"
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </div>

      <div className="mx-auto grid max-w-5xl gap-5 px-4 py-6 lg:grid-cols-[360px_1fr]">
        <div className="space-y-5">
          <div className="overflow-hidden rounded-[28px] border border-border/70 bg-card/90 shadow-[0_20px_70px_-45px_hsl(var(--primary))] backdrop-blur">
            <div className="relative h-32 bg-gradient-to-br from-primary/35 via-blue-400/15 to-cyan-300/20">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_22%_28%,rgba(255,255,255,0.75),transparent_28%),radial-gradient(circle_at_82%_18%,rgba(255,255,255,0.35),transparent_24%)]" />
              <div className="absolute bottom-4 right-4 rounded-full border border-white/50 bg-white/55 px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-primary shadow-sm backdrop-blur">
                Secure profile
              </div>
            </div>

            <div className="-mt-12 px-6 pb-6">
              <input id="avatar-file-input" type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} data-testid="input-avatar-file" />
              <div className="mb-5 flex items-end justify-between">
                <label htmlFor="avatar-file-input" className="group relative cursor-pointer" title="Change photo">
                  <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-[26px] border-4 border-card bg-gradient-to-br from-primary/15 to-primary/5 shadow-xl ring-1 ring-border/70">
                    {avatarUrl ? (
                      <img src={avatarUrl} alt="Avatar" className="h-full w-full object-cover" data-testid="img-avatar" />
                    ) : (
                      <span className="text-2xl font-black text-primary" data-testid="div-avatar-initials">{initials}</span>
                    )}
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center rounded-[26px] bg-slate-950/55 opacity-0 transition-opacity group-hover:opacity-100">
                    {isUploadingAvatar
                      ? <Loader2 size={18} className="animate-spin text-white" />
                      : <Camera size={18} className="text-white" />}
                  </div>
                  <div className="absolute -bottom-2 -right-2 rounded-full border-4 border-card bg-primary p-2 text-primary-foreground shadow-lg transition-transform group-hover:scale-105">
                    <Camera size={13} />
                  </div>
                </label>

                {isAdmin ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-3 py-1.5 text-[11px] font-bold text-primary shadow-sm">
                    <ShieldCheck size={12} /> Admin
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-3 py-1.5 text-[11px] font-bold text-muted-foreground">
                    <Eye size={12} /> Viewer
                  </span>
                )}
              </div>

              {isEditingName ? (
                <div className="mb-2 flex items-center gap-2">
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="h-11 rounded-2xl border-primary/30 bg-background/80 text-lg font-black shadow-inner"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveName();
                      if (e.key === 'Escape') { setIsEditingName(false); setEditName(displayName); }
                    }}
                    data-testid="input-display-name"
                  />
                  <button onClick={handleSaveName} disabled={isSavingName} className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-500 text-white shadow-sm transition hover:bg-emerald-600 disabled:opacity-60">
                    {isSavingName ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                  </button>
                  <button onClick={() => { setIsEditingName(false); setEditName(displayName); }} className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-border bg-card text-muted-foreground transition hover:bg-muted hover:text-foreground">
                    <X size={16} />
                  </button>
                </div>
              ) : (
                <div className="group mb-1 flex items-center gap-2">
                  <h1 className="truncate text-2xl font-black tracking-tight text-foreground">{displayName}</h1>
                  <button
                    onClick={() => setIsEditingName(true)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-transparent text-muted-foreground opacity-80 transition-all hover:border-border hover:bg-muted hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100"
                    data-testid="button-edit-name"
                  >
                    <Pencil size={13} />
                  </button>
                </div>
              )}
              <p className="truncate text-sm font-medium text-muted-foreground">{user?.email || credEmail}</p>

              <div className="mt-5 grid grid-cols-2 gap-3">
                <div className="rounded-2xl border border-border/70 bg-background/70 p-3">
                  <div className="mb-2 inline-flex rounded-xl bg-primary/10 p-2 text-primary">
                    <UserRound size={15} />
                  </div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Role</p>
                  <p className="mt-0.5 text-sm font-black text-foreground">{isAdmin ? 'Admin' : 'Viewer'}</p>
                </div>
                <div className="rounded-2xl border border-border/70 bg-background/70 p-3">
                  <div className="mb-2 inline-flex rounded-xl bg-emerald-500/10 p-2 text-emerald-600">
                    <BadgeCheck size={15} />
                  </div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Status</p>
                  <p className="mt-0.5 text-sm font-black text-foreground">Active</p>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-[24px] border border-border/70 bg-card/80 p-5 shadow-sm backdrop-blur">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-amber-500/10 p-2.5 text-amber-600">
                <LockKeyhole size={17} />
              </div>
              <div>
                <h2 className="text-sm font-black text-foreground">Security note</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Use a strong password and sign out from shared devices.</p>
              </div>
            </div>
          </div>
        </div>

        {isAdmin && (
          <div className="overflow-hidden rounded-[28px] border border-border/70 bg-card/95 shadow-[0_24px_80px_-55px_rgba(15,23,42,0.65)] backdrop-blur">
            <div className="border-b border-border/60 bg-gradient-to-r from-slate-950/[0.03] via-primary/[0.04] to-transparent px-6 py-5 dark:from-white/[0.04]">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="rounded-2xl bg-primary/10 p-3 text-primary ring-1 ring-primary/15">
                    <KeyRound size={18} />
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.24em] text-primary/80">Admin access</p>
                    <h2 className="mt-1 text-xl font-black tracking-tight text-foreground">Login Credentials</h2>
                    <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                      Update the admin email or password. Your current password is required before changes are saved.
                    </p>
                  </div>
                </div>
                <div className="inline-flex items-center gap-1.5 self-start rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-bold text-emerald-600">
                  <BadgeCheck size={12} /> Protected
                </div>
              </div>
            </div>

            <div className="space-y-5 px-6 py-6">
              <div className="grid gap-5 md:grid-cols-2">
                <div className="space-y-2 md:col-span-2">
                  <label className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">
                    <Mail size={13} className="text-primary" /> Email
                  </label>
                  <Input
                    type="email"
                    value={credEmail}
                    onChange={e => { setCredEmail(e.target.value); setCredError(''); setCredSuccess(false); }}
                    placeholder="admin@example.com"
                    className="h-12 rounded-2xl border-border/80 bg-background/70 px-4 text-sm font-semibold shadow-inner transition focus-visible:ring-primary/25"
                  />
                </div>

                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">
                    <LockKeyhole size={13} className="text-primary" /> New Password
                  </label>
                  <Input
                    type="password"
                    value={credPassword}
                    onChange={e => { setCredPassword(e.target.value); setCredError(''); setCredSuccess(false); }}
                    placeholder="Leave blank to keep current"
                    className="h-12 rounded-2xl border-border/80 bg-background/70 px-4 text-sm shadow-inner transition focus-visible:ring-primary/25"
                    autoComplete="new-password"
                  />
                </div>

                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">
                    <Check size={13} className="text-primary" /> Confirm Password
                  </label>
                  <Input
                    type="password"
                    value={credConfirm}
                    onChange={e => { setCredConfirm(e.target.value); setCredError(''); setCredSuccess(false); }}
                    placeholder={credPassword ? 'Repeat new password' : 'Only needed for new password'}
                    disabled={!credPassword}
                    className="h-12 rounded-2xl border-border/80 bg-background/70 px-4 text-sm shadow-inner transition focus-visible:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-55"
                    autoComplete="new-password"
                  />
                </div>
              </div>

              <div className="rounded-[22px] border border-border/70 bg-muted/30 p-4">
                <label className="mb-2 flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">
                  <ShieldCheck size={13} className="text-primary" /> Current Password <span className="text-destructive">*</span>
                </label>
                <Input
                  type="password"
                  value={credCurrentPw}
                  onChange={e => { setCredCurrentPw(e.target.value); setCredError(''); setCredSuccess(false); }}
                  placeholder="Enter current password to confirm changes"
                  className="h-12 rounded-2xl border-border/80 bg-background px-4 text-sm shadow-inner transition focus-visible:ring-primary/25"
                  autoComplete="current-password"
                />
                <p className="mt-2 text-xs leading-5 text-muted-foreground">For security, saving email or password changes will sign you out.</p>
              </div>

              {credError && (
                <div className="flex items-start gap-2 rounded-2xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">
                  <X size={16} className="mt-0.5 flex-shrink-0" /> <span>{credError}</span>
                </div>
              )}
              {credSuccess && (
                <div className="flex items-start gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm font-semibold text-emerald-600">
                  <Check size={16} className="mt-0.5 flex-shrink-0" /> <span>Saved — signing you out…</span>
                </div>
              )}

              <div className="flex flex-col gap-3 border-t border-border/60 pt-5 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-5 text-muted-foreground">Review changes carefully before saving.</p>
                <button
                  onClick={handleSaveCredentials}
                  disabled={credSaving}
                  className="group inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-primary to-blue-500 px-5 py-3 text-sm font-black text-white shadow-lg shadow-primary/20 transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-primary/25 disabled:pointer-events-none disabled:opacity-60"
                >
                  {credSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                  Save Credentials
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Profile;
