import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { createClient } from '@supabase/supabase-js';
import { supabase as defaultSupabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, ShieldCheck, ShieldAlert, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { getConnections, setActiveConnection } from '@/lib/db-config';
import { confirmMemberEmail, createMemberUser, getMemberClient, setMemberSetup } from '@/lib/memberAuth';

const DB_SETTINGS_KEY = 'chat_monitor_db_settings';
const PLATFORM_CONNS_KEY = 'chat_monitor_platform_connections';
const N8N_SETTINGS_KEY = 'chat_monitor_n8n_settings';

const PERMISSION_LABELS: Record<string, string> = {
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
};

const InviteAccept = () => {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [stage, setStage] = useState<'loading' | 'register' | 'creating' | 'done' | 'error'>('loading');
  const [error, setError] = useState('');
  const [invite, setInvite] = useState<Invite | null>(null);

  // Registration form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Decoded invite params — held in state for use during registration
  const [params, setParams] = useState<{
    supabaseUrl: string | null;
    supabaseKey: string | null;
    serviceRoleKey: string | null;
    tableName: string | null;
    memberName: string | null;
    platformConnsJson: string | null;
    n8nSettingsJson: string | null;
  }>({
    supabaseUrl: null, supabaseKey: null, serviceRoleKey: null,
    tableName: null, memberName: null, platformConnsJson: null, n8nSettingsJson: null,
  });

  useEffect(() => {
    if (!token) { navigate('/'); return; }
    validateInvite(token);
  }, [token]);

  // Pre-fill email from invite or member name param
  useEffect(() => {
    const nParam = searchParams.get('n');
    if (nParam) {
      try { /* pre-fill with name later */ } catch { /* ignore */ }
    }
  }, []);

  const validateInvite = async (tok: string) => {
    try {
      let supabaseUrl: string | null = null;
      let supabaseKey: string | null = null;
      let serviceRoleKey: string | null = null;
      let tableName: string | null = null;
      let memberName: string | null = null;
      let platformConnsJson: string | null = null;
      let n8nSettingsJson: string | null = null;

      const uParam = searchParams.get('u');
      const kParam = searchParams.get('k');
      const sParam = searchParams.get('s');
      const tParam = searchParams.get('t');
      const nParam = searchParams.get('n');
      const pParam = searchParams.get('p');
      const qParam = searchParams.get('q');

      if (uParam && kParam) {
        try {
          supabaseUrl = atob(decodeURIComponent(uParam));
          supabaseKey = atob(decodeURIComponent(kParam));
          if (sParam) serviceRoleKey = atob(decodeURIComponent(sParam));
          if (tParam) tableName = atob(decodeURIComponent(tParam));
          if (nParam) memberName = atob(decodeURIComponent(nParam));
          if (pParam) platformConnsJson = atob(decodeURIComponent(pParam));
          if (qParam) n8nSettingsJson = atob(decodeURIComponent(qParam));
        } catch { /* ignore decode errors */ }
      }

      setParams({ supabaseUrl, supabaseKey, serviceRoleKey, tableName, memberName, platformConnsJson, n8nSettingsJson });

      const client = supabaseUrl && supabaseKey
        ? createClient(supabaseUrl, supabaseKey)
        : defaultSupabase;

      const { data, error: rpcErr } = await client.rpc('get_invite_by_token', { p_token: tok });

      if (rpcErr) {
        setError('Could not validate this invite link. Please check the link and try again.');
        setStage('error');
        return;
      }

      const row: Invite | null = Array.isArray(data) ? data[0] ?? null : data ?? null;

      if (!row) {
        // Token not found or already used — may have an account already
        setError('already_used');
        setStage('error');
        return;
      }
      if (row.status === 'revoked') {
        setError('This invite has been revoked. Please contact your admin for a new link.');
        setStage('error');
        return;
      }

      // Store DB credentials in localStorage so dashboard can fetch data
      storeCredentials(supabaseUrl, supabaseKey, serviceRoleKey, tableName, platformConnsJson, n8nSettingsJson);
      setMemberSetup();

      setInvite(row);
      // Pre-fill email if name looks like email, otherwise leave blank
      if (row.email && row.email.includes('@')) setEmail(row.email);
      setStage('register');
    } catch {
      setError('Something went wrong validating the invite. Please try again.');
      setStage('error');
    }
  };

  const storeCredentials = (
    url: string | null,
    anonKey: string | null,
    serviceKey: string | null,
    tableName: string | null,
    platformJson: string | null,
    n8nJson: string | null,
  ) => {
    if (!url || !anonKey) return;

    const existing = getConnections();
    const alreadyExists = existing.some(c => c.url === url);
    if (!alreadyExists) {
      const newConn = {
        id: `member-${Date.now()}`,
        name: 'Workspace',
        dbType: 'supabase' as const,
        url,
        anonKey,
        ...(serviceKey ? { serviceRoleKey: serviceKey } : {}),
        createdAt: new Date().toISOString(),
      };
      localStorage.setItem('meta_db_connections', JSON.stringify([...existing, newConn]));
      setActiveConnection(newConn.id);
    } else {
      const match = existing.find(c => c.url === url)!;
      setActiveConnection(match.id);
    }

    // Legacy key for data-fetching hooks
    const existingLegacy = (() => {
      try { return JSON.parse(localStorage.getItem(DB_SETTINGS_KEY) || 'null'); } catch { return null; }
    })();
    localStorage.setItem(DB_SETTINGS_KEY, JSON.stringify({
      ...(existingLegacy ?? {}),
      db_type: 'supabase',
      supabase_url: url,
      anon_key: anonKey,
      service_role_key: serviceKey ?? anonKey,
      table_name: tableName ?? existingLegacy?.table_name ?? 'n8n_chat_histories',
      is_active: true,
    }));

    if (platformJson) {
      try { localStorage.setItem(PLATFORM_CONNS_KEY, platformJson); } catch { /* ignore */ }
    }
    if (n8nJson) {
      try {
        if (!localStorage.getItem(N8N_SETTINGS_KEY)) localStorage.setItem(N8N_SETTINGS_KEY, n8nJson);
      } catch { /* ignore */ }
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invite) return;
    if (password.length < 6) { toast.error('Password must be at least 6 characters'); return; }
    if (password !== confirmPassword) { toast.error('Passwords do not match'); return; }

    const { supabaseUrl, supabaseKey, serviceRoleKey, memberName } = params;
    if (!supabaseUrl || (!serviceRoleKey && !supabaseKey)) {
      toast.error('Missing workspace credentials. Please ask your admin for a new invite link.');
      return;
    }
    // Use service role key if available, otherwise fall back to anon key
    const effectiveServiceKey = serviceRoleKey ?? supabaseKey!;

    setStage('creating');

    try {
      const displayName = memberName || email.split('@')[0];

      // Create user in external Supabase auth (no email verification)
      const { data: createData, error: createErr } = await createMemberUser({
        url: supabaseUrl,
        serviceKey: effectiveServiceKey,
        anonKey: supabaseKey ?? effectiveServiceKey,  // fallback if admin API fails
        email,
        password,
        role: invite.role,
        permissions: invite.permissions ?? [],
        displayName,
      });

      if (createErr) {
        // If user already exists, try to sign in (they may have registered before)
        if (createErr.message?.toLowerCase().includes('already') || createErr.message?.toLowerCase().includes('exists')) {
          // Guide them to login instead
          setError('An account with this email already exists. Please sign in.');
          setStage('error');
          return;
        }
        toast.error('Failed to create account: ' + createErr.message);
        setStage('register');
        return;
      }

      const newUserId = createData?.user?.id;

      // Confirm email immediately (bypasses Supabase email verification requirement).
      // This uses the service role key — if admin API succeeds, no verification email needed.
      if (newUserId) {
        await confirmMemberEmail(supabaseUrl, effectiveServiceKey, newUserId);
        // Ignore result — if it fails (anon key instead of service key), sign-in will
        // surface the right error and guide the user accordingly.
      }

      // Sign in immediately
      const memberClient = getMemberClient();
      if (!memberClient) throw new Error('No workspace client available');
      const { error: signInErr } = await memberClient.auth.signInWithPassword({ email, password });
      if (signInErr) {
        const needsConfirm = signInErr.message?.toLowerCase().includes('confirm')
          || signInErr.message?.toLowerCase().includes('not confirmed');
        if (needsConfirm) {
          // Email confirmation is required in this Supabase project
          setError('email_confirmation');
          setStage('error');
          return;
        }
        toast.error('Account created but sign-in failed: ' + signInErr.message);
        setStage('register');
        return;
      }

      // Mark invite as accepted in team_invites
      const anonClient = createClient(supabaseUrl, supabaseKey ?? effectiveServiceKey);
      await anonClient
        .from('team_invites')
        .update({
          status: 'accepted',
          ...(newUserId ? { accepted_user_id: newUserId } : {}),
        })
        .eq('token', invite.token);

      setStage('done');
      setTimeout(() => { window.location.href = '/'; }, 1500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong';
      toast.error(msg);
      setStage('register');
    }
  };

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (stage === 'loading') {
    return (
      <Screen>
        <Loader2 size={28} className="animate-spin text-primary mx-auto" />
        <p className="text-sm text-muted-foreground text-center mt-3">Validating invite link…</p>
      </Screen>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────────
  if (stage === 'error') {
    const alreadyUsed = error === 'already_used';
    const emailConfirm = error === 'email_confirmation';
    return (
      <Screen>
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center pb-2">
            <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 ${
              alreadyUsed || emailConfirm ? 'bg-amber-500/10' : 'bg-red-500/10'
            }`}>
              <ShieldAlert size={22} className={alreadyUsed || emailConfirm ? 'text-amber-500' : 'text-red-500'} />
            </div>
            <CardTitle className="text-base">
              {alreadyUsed ? 'Invite Already Used' : emailConfirm ? 'Check Your Email' : 'Invalid Invite'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <p className="text-sm text-muted-foreground">
              {alreadyUsed
                ? 'This invite link has already been used. If you already registered, please sign in.'
                : emailConfirm
                ? 'Your account was created! Please check your email and click the confirmation link, then sign in.'
                : error}
            </p>
            {emailConfirm || alreadyUsed
              ? <Button asChild className="w-full"><Link to="/member-login">Go to Sign In</Link></Button>
              : <Button onClick={() => navigate('/')} variant="outline" className="w-full">Go to Dashboard</Button>
            }
          </CardContent>
        </Card>
      </Screen>
    );
  }

  // ── Creating ─────────────────────────────────────────────────────────────────
  if (stage === 'creating') {
    return (
      <Screen>
        <Loader2 size={28} className="animate-spin text-primary mx-auto" />
        <p className="text-sm text-muted-foreground text-center mt-3">Accepting invitation…</p>
      </Screen>
    );
  }

  // ── Done ──────────────────────────────────────────────────────────────────────
  if (stage === 'done') {
    return (
      <Screen>
        <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto">
          <ShieldCheck size={28} className="text-emerald-500" />
        </div>
        <div className="text-center">
          <p className="text-lg font-bold text-foreground">Account Created!</p>
          <p className="text-sm text-muted-foreground mt-1">Signing you in…</p>
        </div>
        <Loader2 size={16} className="animate-spin text-muted-foreground mx-auto" />
      </Screen>
    );
  }

  // ── Register form ────────────────────────────────────────────────────────────
  const visiblePerms = (invite?.permissions ?? []).filter(p => p in PERMISSION_LABELS);
  const hasServiceKey = !!params.serviceRoleKey;

  return (
    <Screen>
      <Card className="w-full max-w-sm shadow-lg">
        <CardHeader className="text-center pb-2">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
            <UserPlus size={22} className="text-primary" />
          </div>
          <CardTitle className="text-xl font-bold">
            You're Invited!
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Role: <span className="font-semibold text-foreground capitalize">{invite?.role ?? 'Viewer'}</span>
          </p>
        </CardHeader>
        <CardContent className="space-y-4 pt-2">
          {visiblePerms.length > 0 && (
            <div className="rounded-lg bg-muted/40 border border-border p-3 space-y-1.5">
              <p className="text-xs font-semibold text-foreground">Pages you can access</p>
              <div className="flex flex-wrap gap-1">
                {visiblePerms.map(p => (
                  <span key={p} className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                    {PERMISSION_LABELS[p]}
                  </span>
                ))}
              </div>
            </div>
          )}

          <form onSubmit={handleRegister} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="email">Your Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com"
                required
                autoComplete="email"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Choose a Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                required
                autoComplete="new-password"
                minLength={6}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-password">Confirm Password</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Repeat your password"
                required
                autoComplete="new-password"
              />
            </div>
            <Button type="submit" className="w-full mt-1 gap-2">
              <ShieldCheck size={15} /> Accept Invitation
            </Button>
          </form>

          <p className="text-center text-xs text-muted-foreground">
            Already registered?{' '}
            <Link to="/member-login" className="text-primary hover:underline">Sign in here</Link>
          </p>
        </CardContent>
      </Card>
    </Screen>
  );
};

const Screen = ({ children }: { children: React.ReactNode }) => (
  <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4 gap-4">
    {children}
  </div>
);

export default InviteAccept;
