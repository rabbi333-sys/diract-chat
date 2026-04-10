import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useTeamRole } from '@/hooks/useTeamRole';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  ArrowLeft, LogOut, Pencil, Check, X, Copy,
  ShieldCheck, Eye, Loader2, Camera, KeyRound,
} from 'lucide-react';
import { clearGuestSession } from '@/lib/guestSession';
import { signOutMember, hasMemberSetup } from '@/lib/memberAuth';
import { clearAdminSession, getAdminEmail, updateAdminCredentials, hashPassword, verifyAdminCredentials, getAdminDisplayName, setAdminDisplayName, getAdminAvatarUrl, setAdminAvatarUrl } from '@/lib/adminAuth';

/* ================================================================ */
const Profile = () => {
  const navigate = useNavigate();
  const { user, isAdmin, displayName, initials, loading: pageLoading } = useTeamRole();

  const [editName, setEditName] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [isSavingName, setIsSavingName] = useState(false);

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

  useEffect(() => {
    if (displayName && !isEditingName) setEditName(displayName);
  }, [displayName]);

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


      </div>
    </div>
  );
};

export default Profile;
