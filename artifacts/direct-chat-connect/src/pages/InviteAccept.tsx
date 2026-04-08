import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { toast } from 'sonner';
import { Loader2, ShieldCheck, MailCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

const PERMISSION_OPTIONS: Record<string, string> = {
  overview: 'Overview',
  messages: 'Messages',
  handoff: 'Handoff',
  failed: 'Failed',
  orders: 'Orders',
  n8n_prompt: 'n8n Prompt',
};

type Invite = {
  id: string;
  email: string;
  role: string;
  permissions: string[];
  token: string;
  status: string;
  accepted_user_id: string | null;
};

const InviteAccept = () => {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [invite, setInvite] = useState<Invite | null>(null);
  const [loadingInvite, setLoadingInvite] = useState(true);
  const [inviteError, setInviteError] = useState('');

  const [mode, setMode] = useState<'signin' | 'signup'>('signup');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [emailConfirmationSent, setEmailConfirmationSent] = useState(false);

  useEffect(() => {
    if (!token) {
      navigate('/');
      return;
    }
    loadInvite(token);
  }, [token]);

  // Auto-accept if the user is already logged in with the invite email
  useEffect(() => {
    if (!invite) return;
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (user && user.email === invite.email) {
        const accepted = await acceptInvite(user.id);
        if (accepted) {
          toast.success('Access granted! Redirecting…');
          setDone(true);
          setTimeout(() => navigate('/'), 1500);
        } else {
          toast.error('Could not accept invite. Please contact the admin.');
        }
      }
    });
  }, [invite]);

  const loadInvite = async (tok: string) => {
    try {
      const { data, error } = await supabase.rpc('get_invite_by_token', { p_token: tok });

      if (error) {
        setInviteError('Could not load this invite. Please check the link and try again.');
        return;
      }

      const row = Array.isArray(data) ? data[0] : data;

      if (!row) {
        setInviteError('This invite link is invalid or has expired.');
        return;
      }
      if (row.status === 'accepted') {
        setInviteError('This invite has already been used. Sign in to access the dashboard.');
        return;
      }
      if (row.status === 'revoked') {
        setInviteError('This invite has been revoked. Please contact the admin for a new invite.');
        return;
      }

      setInvite(row);
    } finally {
      setLoadingInvite(false);
    }
  };

  /** Accept the invite and return true on success, false on failure. */
  const acceptInvite = async (userId: string): Promise<boolean> => {
    if (!invite) return false;
    const { error } = await supabase
      .from('team_invites')
      .update({ status: 'accepted', accepted_user_id: userId })
      .eq('token', invite.token);
    if (error) {
      console.error('Failed to accept invite:', error.message);
      return false;
    }
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invite) return;

    setIsSubmitting(true);
    try {
      if (mode === 'signup') {
        // ── Server-side creation: no email verification required ──
        // The edge function uses the Supabase admin API to create the user
        // with email_confirm: true so no verification email is ever sent.
        const { data: fnData, error: fnErr } = await supabase.functions.invoke(
          'create-confirmed-user',
          { body: { token, email: invite.email, password } }
        );

        if (fnErr || fnData?.error) {
          // Edge function not deployed yet — fall back to standard signUp
          const { data, error } = await supabase.auth.signUp({
            email: invite.email,
            password,
            options: { emailRedirectTo: `${window.location.origin}/invite/${token}` },
          });
          if (error) { toast.error(error.message); return; }
          if (data.session) {
            const userId = data.user?.id;
            if (userId) {
              await acceptInvite(userId);
              toast.success('Account created! Welcome to the dashboard.');
              setDone(true);
              setTimeout(() => navigate('/'), 1500);
            }
          } else {
            setEmailConfirmationSent(true);
          }
          return;
        }

        // Edge function succeeded → sign in immediately (no email verification)
        const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
          email: invite.email,
          password,
        });
        if (signInErr) { toast.error(signInErr.message); return; }
        toast.success('Account created! Welcome to the dashboard.');
        setDone(true);
        setTimeout(() => navigate('/'), 1500);
        return;
      } else {
        // Sign-in always yields an immediate session — accept invite right away
        const { data, error } = await supabase.auth.signInWithPassword({
          email: invite.email,
          password,
        });
        if (error) {
          toast.error(error.message);
          return;
        }
        const userId = data.user?.id;
        if (userId) {
          const accepted = await acceptInvite(userId);
          if (accepted) {
            toast.success('Signed in! Welcome to the dashboard.');
            setDone(true);
            setTimeout(() => navigate('/'), 1500);
          } else {
            toast.error(
              'Signed in, but invite acceptance failed. Please contact the admin.'
            );
          }
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loadingInvite) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (inviteError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-lg">Invite Error</CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <p className="text-muted-foreground text-sm">{inviteError}</p>
            <Button onClick={() => navigate('/')} className="w-full">Go to Dashboard</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (emailConfirmationSent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
            <MailCheck size={28} className="text-primary" />
          </div>
          <p className="text-base font-semibold text-foreground">Check your email</p>
          <p className="text-sm text-muted-foreground">
            We sent a confirmation link to <strong className="text-foreground">{invite?.email}</strong>.
            Click it to verify your account — you'll be brought back here to complete your setup automatically.
          </p>
          <p className="text-xs text-muted-foreground/70">
            After confirming, you'll be redirected to this invite page and given dashboard access.
          </p>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="text-center space-y-3">
          <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto">
            <ShieldCheck size={28} className="text-emerald-500" />
          </div>
          <p className="text-base font-semibold text-foreground">Access granted!</p>
          <p className="text-sm text-muted-foreground">Redirecting to dashboard…</p>
          <Loader2 size={16} className="animate-spin text-muted-foreground mx-auto" />
        </div>
      </div>
    );
  }

  const visiblePerms = invite?.permissions?.filter((p) => p in PERMISSION_OPTIONS) ?? [];

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
            <ShieldCheck size={22} className="text-primary" />
          </div>
          <CardTitle className="text-xl font-bold">
            You've been invited to{' '}
            <span className="text-primary">Chat Monitor</span>
          </CardTitle>
          <CardDescription className="text-sm">
            {mode === 'signup' ? 'Sign up' : 'Sign in'} to access the dashboard as a{' '}
            <span className="font-medium text-foreground">
              {invite?.role === 'admin' ? 'Admin' : 'Viewer'}
            </span>
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {/* Permissions preview */}
          {invite?.role === 'viewer' && visiblePerms.length > 0 && (
            <div className="rounded-xl bg-muted/40 border border-border p-3 space-y-2">
              <p className="text-xs font-semibold text-foreground">Pages you can access</p>
              <div className="flex flex-wrap gap-1.5">
                {visiblePerms.map((perm) => (
                  <span
                    key={perm}
                    className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary"
                  >
                    {PERMISSION_OPTIONS[perm]}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Toggle sign-in / sign-up */}
          <div className="flex rounded-lg border border-border overflow-hidden text-sm">
            <button
              type="button"
              onClick={() => setMode('signup')}
              className={cn(
                'flex-1 py-2 font-medium transition-colors',
                mode === 'signup' ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted'
              )}
            >
              Sign Up
            </button>
            <button
              type="button"
              onClick={() => setMode('signin')}
              className={cn(
                'flex-1 py-2 font-medium transition-colors',
                mode === 'signin' ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted'
              )}
            >
              Sign In
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={invite?.email ?? ''}
                readOnly
                className="text-sm bg-muted/50 cursor-not-allowed"
                data-testid="input-invite-email-readonly"
              />
              <p className="text-[10px] text-muted-foreground">
                This email was specified in your invite and cannot be changed.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="invite-password">Password</Label>
              <Input
                id="invite-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'signup' ? 'Create a password (min. 6 chars)' : 'Enter your password'}
                required
                minLength={mode === 'signup' ? 6 : undefined}
                data-testid="input-invite-password"
              />
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={isSubmitting || !password}
              data-testid="button-invite-submit"
            >
              {isSubmitting ? (
                <><Loader2 size={14} className="animate-spin mr-2" /> {mode === 'signup' ? 'Creating account…' : 'Signing in…'}</>
              ) : (
                mode === 'signup' ? 'Create Account & Join' : 'Sign In & Join'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export default InviteAccept;
