import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { createClient } from '@supabase/supabase-js';
import { supabase as defaultSupabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, ShieldCheck, ShieldAlert, UserPlus, Clock, Database, Eye, EyeOff, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { getConnections, setActiveConnection, DB_TYPES, type MainDbType } from '@/lib/db-config';
import { hashPassword, setMemberSetup } from '@/lib/memberAuth';
import {
  decodeNonSupabaseCreds, proxyGetInviteByToken, proxySubmitInvite,
  storeMemberProxyCreds, type DbCreds,
} from '@/lib/memberAuthProxy';

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

  const [stage, setStage] = useState<'loading' | 'register' | 'submitting' | 'setup-db' | 'done' | 'error'>('loading');
  const [error, setError] = useState('');
  const [invite, setInvite] = useState<Invite | null>(null);
  const [nonSupabaseCreds, setNonSupabaseCreds] = useState<DbCreds | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Sub-Admin own DB setup state
  const [saDbType, setSaDbType] = useState<MainDbType>('supabase');
  const [saUrl, setSaUrl] = useState('');
  const [saAnonKey, setSaAnonKey] = useState('');
  const [saShowAnonKey, setSaShowAnonKey] = useState(false);
  const [saHost, setSaHost] = useState('');
  const [saPort, setSaPort] = useState('');
  const [saUsername, setSaUsername] = useState('');
  const [saPassword, setSaPassword] = useState('');
  const [saDbName, setSaDbName] = useState('');
  const [saConnStr, setSaConnStr] = useState('');
  const [saConnecting, setSaConnecting] = useState(false);

  // Decoded invite params
  const [params, setParams] = useState<{
    supabaseUrl: string | null;
    supabaseKey: string | null;
    tableName: string | null;
    memberName: string | null;
    platformConnsJson: string | null;
    n8nSettingsJson: string | null;
  }>({
    supabaseUrl: null, supabaseKey: null,
    tableName: null, memberName: null, platformConnsJson: null, n8nSettingsJson: null,
  });

  useEffect(() => {
    if (!token) { navigate('/'); return; }
    validateInvite(token);
  }, [token]);

  const validateInvite = async (tok: string) => {
    try {
      let memberName: string | null = null;
      let platformConnsJson: string | null = null;
      let n8nSettingsJson: string | null = null;

      const nParam = searchParams.get('n');
      const pParam = searchParams.get('p');
      const qParam = searchParams.get('q');
      if (nParam) { try { memberName = atob(decodeURIComponent(nParam)); } catch { /* ignore */ } }
      if (pParam) { try { platformConnsJson = atob(decodeURIComponent(pParam)); } catch { /* ignore */ } }
      if (qParam) { try { n8nSettingsJson = atob(decodeURIComponent(qParam)); } catch { /* ignore */ } }

      // ── Non-Supabase: ?x= param ───────────────────────────────────────────
      const xParam = searchParams.get('x');
      if (xParam) {
        const creds = decodeNonSupabaseCreds(decodeURIComponent(xParam));
        if (!creds) {
          setError('Invalid invite link credentials. Please ask your admin for a new link.');
          setStage('error');
          return;
        }
        setNonSupabaseCreds(creds);
        setParams({ supabaseUrl: null, supabaseKey: null, tableName: null, memberName, platformConnsJson, n8nSettingsJson });

        const invite = await proxyGetInviteByToken(creds, tok);
        if (!invite) {
          setError('already_used');
          setStage('error');
          return;
        }
        if (invite.status === 'revoked' || invite.status === 'rejected') {
          setError('This invite has been revoked. Please contact your admin for a new link.');
          setStage('error');
          return;
        }
        setInvite({ id: invite.id, email: invite.email, role: invite.role, permissions: invite.permissions, token: invite.token, status: invite.status });
        if (memberName) setName(memberName);
        if (invite.email?.includes('@')) setEmail(invite.email);
        setStage('register');
        return;
      }

      // ── Supabase: ?u= ?k= params ──────────────────────────────────────────
      let supabaseUrl: string | null = null;
      let supabaseKey: string | null = null;
      let tableName: string | null = null;
      const uParam = searchParams.get('u');
      const kParam = searchParams.get('k');
      const tParam = searchParams.get('t');

      if (uParam && kParam) {
        try {
          supabaseUrl = atob(decodeURIComponent(uParam));
          supabaseKey = atob(decodeURIComponent(kParam));
          if (tParam) tableName = atob(decodeURIComponent(tParam));
        } catch { /* ignore decode errors */ }
      }

      setParams({ supabaseUrl, supabaseKey, tableName, memberName, platformConnsJson, n8nSettingsJson });

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
        setError('already_used');
        setStage('error');
        return;
      }
      if (row.status === 'revoked' || row.status === 'rejected') {
        setError('This invite has been revoked. Please contact your admin for a new link.');
        setStage('error');
        return;
      }

      setInvite(row);
      if (memberName) setName(memberName);
      if (row.email && row.email.includes('@')) setEmail(row.email);
      setStage('register');
    } catch (err) {
      setError('Something went wrong validating the invite. Please try again.');
      setStage('error');
    }
  };

  const storeCredentials = (
    url: string,
    anonKey: string,
    tableName: string | null,
    platformJson: string | null,
    n8nJson: string | null,
  ) => {
    const existing = getConnections();
    const alreadyExists = existing.some(c => c.url === url);
    if (!alreadyExists) {
      const newConn = {
        id: `member-${Date.now()}`,
        name: 'Workspace',
        dbType: 'supabase' as const,
        url,
        anonKey,
        createdAt: new Date().toISOString(),
      };
      localStorage.setItem('meta_db_connections', JSON.stringify([...existing, newConn]));
      setActiveConnection(newConn.id);
    } else {
      const match = existing.find(c => c.url === url)!;
      setActiveConnection(match.id);
    }

    const existingLegacy = (() => {
      try { return JSON.parse(localStorage.getItem(DB_SETTINGS_KEY) || 'null'); } catch { return null; }
    })();
    localStorage.setItem(DB_SETTINGS_KEY, JSON.stringify({
      ...(existingLegacy ?? {}),
      db_type: 'supabase',
      supabase_url: url,
      anon_key: anonKey,
      service_role_key: anonKey, // members use anon key only — privileged ops use SECURITY DEFINER RPCs
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invite || !token) return;
    if (!name.trim()) { toast.error('Please enter your name'); return; }
    if (!email.trim()) { toast.error('Please enter your email'); return; }
    if (password.length < 6) { toast.error('Password must be at least 6 characters'); return; }
    if (password !== confirmPassword) { toast.error('Passwords do not match'); return; }

    setStage('submitting');

    try {
      const passwordHash = await hashPassword(password);
      const { supabaseUrl, supabaseKey, tableName, platformConnsJson, n8nSettingsJson } = params;

      // ── Non-Supabase path ────────────────────────────────────────────────
      if (nonSupabaseCreds) {
        const result = await proxySubmitInvite(
          nonSupabaseCreds, token,
          name.trim(), email.toLowerCase().trim(), passwordHash,
        );
        if (result === 'not_found') {
          toast.error('This invite link is no longer valid. Please ask your admin for a new one.');
          setStage('register');
          return;
        }
        // Store proxy creds so member-login page can use them
        storeMemberProxyCreds(nonSupabaseCreds);
        setMemberSetup();
        if (platformConnsJson) { try { localStorage.setItem(PLATFORM_CONNS_KEY, platformConnsJson); } catch { /* ignore */ } }
        if (n8nSettingsJson) { try { if (!localStorage.getItem(N8N_SETTINGS_KEY)) localStorage.setItem(N8N_SETTINGS_KEY, n8nSettingsJson); } catch { /* ignore */ } }
        if (invite.role === 'sub-admin') { setStage('setup-db'); return; }
        setStage('done');
        return;
      }

      // ── Supabase path ────────────────────────────────────────────────────
      if (!supabaseUrl || !supabaseKey) {
        toast.error('Missing workspace credentials. Please ask your admin for a new invite link.');
        setStage('register');
        return;
      }

      const client = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { data: result, error: rpcErr } = await client.rpc('submit_invite_request', {
        p_token: token,
        p_name: name.trim(),
        p_email: email.toLowerCase().trim(),
        p_password_hash: passwordHash,
      });

      if (rpcErr) {
        if (rpcErr.message?.includes('function') || rpcErr.message?.includes('submit_invite')) {
          toast.error('Database needs updating. Ask your admin to run the SQL setup from their Profile page.');
          setStage('register');
          return;
        }
        toast.error('Failed to submit: ' + rpcErr.message);
        setStage('register');
        return;
      }

      if (result === 'not_found') {
        toast.error('This invite link is no longer valid. Please ask your admin for a new one.');
        setStage('register');
        return;
      }

      storeCredentials(supabaseUrl, supabaseKey, tableName, platformConnsJson, n8nSettingsJson);
      setMemberSetup();
      if (invite.role === 'sub-admin') { setStage('setup-db'); return; }
      setStage('done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong';
      toast.error(msg);
      setStage('register');
    }
  };

  // ── Sub-Admin: save own DB ────────────────────────────────────────────────────
  const SUBADMIN_DB_KEY = 'meta_subadmin_db_creds';

  const handleSaveOwnDb = async () => {
    setSaConnecting(true);
    try {
      const needsConnStr = saDbType === 'mongodb' || saDbType === 'redis';
      if (saDbType === 'supabase') {
        if (!saUrl.trim() || !saAnonKey.trim()) { toast.error('Please enter Supabase URL and Anon Key'); return; }
        const credsObj = { dbType: 'supabase', url: saUrl.trim(), anonKey: saAnonKey.trim() };
        localStorage.setItem(SUBADMIN_DB_KEY, JSON.stringify(credsObj));
        const existing = getConnections();
        const alreadyExists = existing.find(c => c.url === saUrl.trim());
        let connId: string;
        if (!alreadyExists) {
          const newConn = {
            id: `subadmin-${Date.now()}`,
            name: 'My Database',
            dbType: 'supabase' as const,
            url: saUrl.trim(),
            anonKey: saAnonKey.trim(),
            createdAt: new Date().toISOString(),
          };
          localStorage.setItem('meta_db_connections', JSON.stringify([...existing, newConn]));
          connId = newConn.id;
        } else {
          connId = alreadyExists.id;
        }
        setActiveConnection(connId);
      } else if (needsConnStr) {
        if (!saConnStr.trim()) { toast.error('Please enter a connection string'); return; }
        const credsObj = { dbType: saDbType, connectionString: saConnStr.trim() };
        localStorage.setItem(SUBADMIN_DB_KEY, JSON.stringify(credsObj));
        storeMemberProxyCreds({ dbType: saDbType, connectionString: saConnStr.trim() });
      } else {
        if (!saHost.trim() || !saUsername.trim()) { toast.error('Please enter host and username'); return; }
        const credsObj = {
          dbType: saDbType, host: saHost.trim(), port: saPort.trim(), dbUsername: saUsername.trim(),
          dbPassword: saPassword, dbName: saDbName.trim(),
        };
        localStorage.setItem(SUBADMIN_DB_KEY, JSON.stringify(credsObj));
        storeMemberProxyCreds({ dbType: saDbType, host: saHost.trim(), port: saPort.trim(), dbUsername: saUsername.trim(), dbPassword: saPassword, dbName: saDbName.trim() });
      }
      toast.success('Your database connected!');
      setStage('done');
    } finally {
      setSaConnecting(false);
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
    return (
      <Screen>
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center pb-2">
            <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 ${
              alreadyUsed ? 'bg-amber-500/10' : 'bg-red-500/10'
            }`}>
              <ShieldAlert size={22} className={alreadyUsed ? 'text-amber-500' : 'text-red-500'} />
            </div>
            <CardTitle className="text-base">
              {alreadyUsed ? 'Invite Already Used' : 'Invalid Invite'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <p className="text-sm text-muted-foreground">
              {alreadyUsed
                ? 'This invite link has already been used. If you already submitted a request, please sign in.'
                : error}
            </p>
            {alreadyUsed
              ? <Button asChild className="w-full"><Link to="/member-login">Sign In</Link></Button>
              : <Button onClick={() => navigate('/')} variant="outline" className="w-full">Go to Dashboard</Button>
            }
          </CardContent>
        </Card>
      </Screen>
    );
  }

  // ── Submitting ───────────────────────────────────────────────────────────────
  if (stage === 'submitting') {
    return (
      <Screen>
        <Loader2 size={28} className="animate-spin text-primary mx-auto" />
        <p className="text-sm text-muted-foreground text-center mt-3">Submitting your request…</p>
      </Screen>
    );
  }

  // ── Setup DB (Sub-Admin) ──────────────────────────────────────────────────────
  if (stage === 'setup-db') {
    const saCurrentDbType = DB_TYPES.find(t => t.value === saDbType);
    const saNeedsConnStr = saDbType === 'mongodb' || saDbType === 'redis';
    const saNeedsHostFields = saDbType === 'postgresql' || saDbType === 'mysql';

    return (
      <Screen>
        <Card className="w-full max-w-sm shadow-lg">
          <CardHeader className="text-center pb-2">
            <div className="w-12 h-12 rounded-full bg-violet-500/10 flex items-center justify-center mx-auto mb-3">
              <Database size={22} className="text-violet-600 dark:text-violet-400" />
            </div>
            <CardTitle className="text-xl font-bold">Connect Your Database</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              As a Sub-Admin, connect your <strong>own database</strong> — you'll see only your data.
            </p>
          </CardHeader>
          <CardContent className="space-y-3 pt-2">
            <div className="rounded-lg bg-violet-500/5 border border-violet-500/20 px-3 py-2.5">
              <p className="text-xs text-violet-700 dark:text-violet-400 leading-relaxed">
                Your admin will still need to approve your account. After approval, you'll be logged into your own database workspace.
              </p>
            </div>

            {/* DB Type */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Database Type</label>
              <div className="relative">
                <select
                  value={saDbType}
                  onChange={e => setSaDbType(e.target.value as MainDbType)}
                  className="w-full appearance-none h-9 rounded-xl border border-border/60 bg-muted/30 px-3 pr-8 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25 transition-colors"
                >
                  {DB_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.icon} {t.label}</option>
                  ))}
                </select>
                <ChevronDown size={12} className="absolute right-2.5 top-2.5 text-muted-foreground pointer-events-none" />
              </div>
            </div>

            {/* Supabase fields */}
            {saDbType === 'supabase' && (
              <>
                <div className="space-y-1.5">
                  <Label>Supabase Project URL</Label>
                  <Input value={saUrl} onChange={e => setSaUrl(e.target.value)} placeholder="https://xxx.supabase.co" className="h-9 rounded-xl" />
                </div>
                <div className="space-y-1.5">
                  <Label>Anon Key</Label>
                  <div className="relative">
                    <Input
                      type={saShowAnonKey ? 'text' : 'password'}
                      value={saAnonKey}
                      onChange={e => setSaAnonKey(e.target.value)}
                      placeholder="eyJ..."
                      className="h-9 rounded-xl pr-9"
                    />
                    <button type="button" onClick={() => setSaShowAnonKey(s => !s)} className="absolute right-2.5 top-2 text-muted-foreground hover:text-foreground">
                      {saShowAnonKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* PG / MySQL fields */}
            {saNeedsHostFields && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2 space-y-1.5">
                    <Label>Host</Label>
                    <Input value={saHost} onChange={e => setSaHost(e.target.value)} placeholder="localhost" className="h-9 rounded-xl" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Port</Label>
                    <Input value={saPort} onChange={e => setSaPort(e.target.value)} placeholder={saCurrentDbType?.defaultPort || ''} className="h-9 rounded-xl" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label>Username</Label>
                    <Input value={saUsername} onChange={e => setSaUsername(e.target.value)} placeholder="root" className="h-9 rounded-xl" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Password</Label>
                    <Input type="password" value={saPassword} onChange={e => setSaPassword(e.target.value)} placeholder="••••••••" className="h-9 rounded-xl" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Database Name</Label>
                  <Input value={saDbName} onChange={e => setSaDbName(e.target.value)} placeholder="mydb" className="h-9 rounded-xl" />
                </div>
              </>
            )}

            {/* MongoDB / Redis */}
            {saNeedsConnStr && (
              <div className="space-y-1.5">
                <Label>Connection String</Label>
                <Input value={saConnStr} onChange={e => setSaConnStr(e.target.value)} placeholder={saDbType === 'mongodb' ? 'mongodb+srv://...' : 'redis://...'} className="h-9 rounded-xl" />
              </div>
            )}

            <Button onClick={handleSaveOwnDb} disabled={saConnecting} className="w-full mt-1 gap-2 bg-violet-600 hover:bg-violet-700">
              {saConnecting ? <><Loader2 size={14} className="animate-spin" /> Connecting…</> : <><Database size={14} /> Save My Database</>}
            </Button>

            <button
              onClick={() => setStage('done')}
              className="w-full text-xs text-center text-muted-foreground hover:text-foreground transition-colors py-1"
            >
              Skip for now — I'll connect later
            </button>
          </CardContent>
        </Card>
      </Screen>
    );
  }

  // ── Done ──────────────────────────────────────────────────────────────────────
  if (stage === 'done') {
    return (
      <Screen>
        <Card className="w-full max-w-sm shadow-lg">
          <CardHeader className="text-center pb-2">
            <div className="w-14 h-14 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto mb-3">
              <Clock size={26} className="text-emerald-500" />
            </div>
            <CardTitle className="text-lg">Request Submitted!</CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <p className="text-sm text-muted-foreground">
              Your request has been sent to your admin for review. Once approved, you can sign in with your email and password.
            </p>
            <Button asChild className="w-full">
              <Link to="/member-login">Go to Sign In</Link>
            </Button>
          </CardContent>
        </Card>
      </Screen>
    );
  }

  // ── Register form ────────────────────────────────────────────────────────────
  const visiblePerms = (invite?.permissions ?? []).filter(p => p in PERMISSION_LABELS);

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

          <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 p-3">
            <p className="text-xs text-blue-600 dark:text-blue-400">
              Fill in your details and click "Accept Invitation". Your admin will then approve your access.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="name">Your Name</Label>
              <Input
                id="name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Full name"
                required
                autoComplete="name"
              />
            </div>
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
            Already approved?{' '}
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
