import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { createClient } from '@supabase/supabase-js';
import { supabase as defaultSupabase } from '@/integrations/supabase/client';
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

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

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
      service_role_key: anonKey,
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
        storeMemberProxyCreds(nonSupabaseCreds);
        setMemberSetup();
        if (platformConnsJson) { try { localStorage.setItem(PLATFORM_CONNS_KEY, platformConnsJson); } catch { /* ignore */ } }
        if (n8nSettingsJson) { try { if (!localStorage.getItem(N8N_SETTINGS_KEY)) localStorage.setItem(N8N_SETTINGS_KEY, n8nSettingsJson); } catch { /* ignore */ } }
        if (invite.role === 'sub-admin') { setStage('setup-db'); return; }
        setStage('done');
        return;
      }

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

  if (stage === 'loading') {
    return (
      <Screen>
        <Loader2 size={32} className="animate-spin mx-auto" style={{ color: '#6366f1' }} />
        <p className="text-sm text-center mt-3" style={{ color: 'rgba(148,163,184,0.8)' }}>Validating invite link…</p>
      </Screen>
    );
  }

  if (stage === 'error') {
    const alreadyUsed = error === 'already_used';
    return (
      <Screen>
        <GlassCard>
          <div className="text-center mb-5">
            <div className={`w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4 ${
              alreadyUsed ? 'bg-amber-500/15' : 'bg-red-500/15'
            }`}>
              <ShieldAlert size={26} className={alreadyUsed ? 'text-amber-400' : 'text-red-400'} />
            </div>
            <h2 className="text-lg font-bold text-white">
              {alreadyUsed ? 'Invite Already Used' : 'Invalid Invite'}
            </h2>
            <p className="text-sm mt-2" style={{ color: 'rgba(148,163,184,0.8)' }}>
              {alreadyUsed
                ? 'This invite link has already been used. If you already submitted a request, please sign in.'
                : error}
            </p>
          </div>
          {alreadyUsed
            ? <DarkButton asLink to="/member-login">Sign In</DarkButton>
            : <DarkButton onClick={() => navigate('/')}>Go to Dashboard</DarkButton>
          }
        </GlassCard>
      </Screen>
    );
  }

  if (stage === 'submitting') {
    return (
      <Screen>
        <Loader2 size={32} className="animate-spin mx-auto" style={{ color: '#6366f1' }} />
        <p className="text-sm text-center mt-3" style={{ color: 'rgba(148,163,184,0.8)' }}>Submitting your request…</p>
      </Screen>
    );
  }

  if (stage === 'setup-db') {
    const saCurrentDbType = DB_TYPES.find(t => t.value === saDbType);
    const saNeedsConnStr = saDbType === 'mongodb' || saDbType === 'redis';
    const saNeedsHostFields = saDbType === 'postgresql' || saDbType === 'mysql';

    return (
      <Screen>
        <GlassCard>
          <div className="text-center mb-5">
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ background: 'rgba(124,58,237,0.15)' }}>
              <Database size={26} style={{ color: '#a78bfa' }} />
            </div>
            <h2 className="text-xl font-bold text-white">Connect Your Database</h2>
            <p className="text-sm mt-1.5" style={{ color: 'rgba(148,163,184,0.8)' }}>
              As a Sub-Admin, connect your <strong className="text-white">own database</strong> — you'll see only your data.
            </p>
          </div>

          <div className="rounded-xl px-3.5 py-3 mb-4" style={{
            background: 'rgba(124,58,237,0.08)',
            border: '1px solid rgba(124,58,237,0.25)',
          }}>
            <p className="text-xs leading-relaxed" style={{ color: '#c4b5fd' }}>
              Your admin will still need to approve your account. After approval, you'll be logged into your own database workspace.
            </p>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'rgba(148,163,184,0.7)' }}>Database Type</label>
              <div className="relative">
                <select
                  value={saDbType}
                  onChange={e => setSaDbType(e.target.value as MainDbType)}
                  className="w-full appearance-none h-10 rounded-xl px-3 pr-8 text-sm focus:outline-none transition-colors"
                  style={{
                    background: 'rgba(30,41,59,0.8)',
                    border: '1px solid rgba(99,102,241,0.2)',
                    color: 'rgba(203,213,225,0.9)',
                  }}
                >
                  {DB_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.icon} {t.label}</option>
                  ))}
                </select>
                <ChevronDown size={12} className="absolute right-2.5 top-3.5 pointer-events-none" style={{ color: 'rgba(148,163,184,0.6)' }} />
              </div>
            </div>

            {saDbType === 'supabase' && (
              <>
                <DarkField label="Supabase Project URL">
                  <DarkInput value={saUrl} onChange={e => setSaUrl(e.target.value)} placeholder="https://xxx.supabase.co" />
                </DarkField>
                <DarkField label="Anon Key">
                  <div className="relative">
                    <DarkInput
                      type={saShowAnonKey ? 'text' : 'password'}
                      value={saAnonKey}
                      onChange={e => setSaAnonKey(e.target.value)}
                      placeholder="eyJ..."
                      className="pr-9"
                    />
                    <button type="button" onClick={() => setSaShowAnonKey(s => !s)}
                      className="absolute right-2.5 top-2.5" style={{ color: 'rgba(148,163,184,0.6)' }}>
                      {saShowAnonKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </DarkField>
              </>
            )}

            {saNeedsHostFields && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <DarkField label="Host" className="col-span-2">
                    <DarkInput value={saHost} onChange={e => setSaHost(e.target.value)} placeholder="localhost" />
                  </DarkField>
                  <DarkField label="Port">
                    <DarkInput value={saPort} onChange={e => setSaPort(e.target.value)} placeholder={saCurrentDbType?.defaultPort || ''} />
                  </DarkField>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <DarkField label="Username">
                    <DarkInput value={saUsername} onChange={e => setSaUsername(e.target.value)} placeholder="root" />
                  </DarkField>
                  <DarkField label="Password">
                    <DarkInput type="password" value={saPassword} onChange={e => setSaPassword(e.target.value)} placeholder="••••••••" />
                  </DarkField>
                </div>
                <DarkField label="Database Name">
                  <DarkInput value={saDbName} onChange={e => setSaDbName(e.target.value)} placeholder="mydb" />
                </DarkField>
              </>
            )}

            {saNeedsConnStr && (
              <DarkField label="Connection String">
                <DarkInput value={saConnStr} onChange={e => setSaConnStr(e.target.value)}
                  placeholder={saDbType === 'mongodb' ? 'mongodb+srv://...' : 'redis://...'} />
              </DarkField>
            )}

            <GradientButton onClick={handleSaveOwnDb} disabled={saConnecting} className="w-full mt-1">
              {saConnecting ? <><Loader2 size={14} className="animate-spin" /> Connecting…</> : <><Database size={14} /> Save My Database</>}
            </GradientButton>

            <button
              onClick={() => setStage('done')}
              className="w-full text-xs text-center py-1 transition-colors"
              style={{ color: 'rgba(148,163,184,0.6)' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'rgba(203,213,225,0.9)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'rgba(148,163,184,0.6)')}
            >
              Skip for now — I'll connect later
            </button>
          </div>
        </GlassCard>
      </Screen>
    );
  }

  if (stage === 'done') {
    return (
      <Screen>
        <GlassCard>
          <div className="text-center mb-5">
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ background: 'rgba(16,185,129,0.15)' }}>
              <Clock size={26} style={{ color: '#34d399' }} />
            </div>
            <h2 className="text-xl font-bold text-white">Request Submitted!</h2>
            <p className="text-sm mt-2" style={{ color: 'rgba(148,163,184,0.8)' }}>
              Your request has been sent to your admin for review. Once approved, you can sign in with your email and password.
            </p>
          </div>
          <DarkButton asLink to="/member-login">Go to Sign In</DarkButton>
        </GlassCard>
      </Screen>
    );
  }

  const visiblePerms = (invite?.permissions ?? []).filter(p => p in PERMISSION_LABELS);

  return (
    <Screen>
      <div className="mb-6 text-center">
        <div className="inline-flex items-center gap-2 mb-4">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
        </div>
        <h1 className="text-3xl font-bold text-white tracking-tight">
          Chat <span style={{ background: 'linear-gradient(90deg, #3b82f6, #8b5cf6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Monitor</span>
        </h1>
        <p className="mt-2 text-sm" style={{ color: 'rgba(148,163,184,0.8)' }}>You've been invited to join</p>
      </div>

      <GlassCard>
        <div className="text-center mb-5">
          <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3"
            style={{ background: 'rgba(99,102,241,0.15)' }}>
            <UserPlus size={22} style={{ color: '#818cf8' }} />
          </div>
          <h2 className="text-xl font-bold text-white">You're Invited!</h2>
          <p className="text-sm mt-1" style={{ color: 'rgba(148,163,184,0.8)' }}>
            Role: <span className="font-semibold text-white capitalize">{invite?.role ?? 'Viewer'}</span>
          </p>
        </div>

        {visiblePerms.length > 0 && (
          <div className="rounded-xl px-3.5 py-3 mb-4" style={{
            background: 'rgba(30,41,59,0.6)',
            border: '1px solid rgba(99,102,241,0.15)',
          }}>
            <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'rgba(148,163,184,0.7)' }}>Pages you can access</p>
            <div className="flex flex-wrap gap-1.5">
              {visiblePerms.map(p => (
                <span key={p} className="text-[10px] font-semibold px-2.5 py-0.5 rounded-full"
                  style={{ background: 'rgba(99,102,241,0.2)', color: '#a5b4fc', border: '1px solid rgba(99,102,241,0.25)' }}>
                  {PERMISSION_LABELS[p]}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-xl px-3.5 py-3 mb-5" style={{
          background: 'rgba(59,130,246,0.08)',
          border: '1px solid rgba(59,130,246,0.2)',
        }}>
          <p className="text-xs leading-relaxed" style={{ color: '#93c5fd' }}>
            Fill in your details and click "Accept Invitation". Your admin will then approve your access.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5">
          <DarkField label="Your Name">
            <DarkInput
              id="name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Full name"
              required
              autoComplete="name"
            />
          </DarkField>

          <DarkField label="Your Email">
            <DarkInput
              id="email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              autoComplete="email"
            />
          </DarkField>

          <DarkField label="Choose a Password">
            <DarkInput
              id="password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="At least 6 characters"
              required
              autoComplete="new-password"
              minLength={6}
            />
          </DarkField>

          <DarkField label="Confirm Password">
            <DarkInput
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder="Repeat your password"
              required
              autoComplete="new-password"
            />
          </DarkField>

          <GradientButton type="submit" className="w-full mt-1">
            <ShieldCheck size={15} /> Accept Invitation
          </GradientButton>
        </form>

        <p className="text-center text-xs mt-4" style={{ color: 'rgba(100,116,139,0.8)' }}>
          Already approved?{' '}
          <Link to="/member-login" style={{ color: '#818cf8' }} className="hover:underline">Sign in here</Link>
        </p>
      </GlassCard>

      <p className="mt-4 text-center text-xs" style={{ color: 'rgba(100,116,139,0.7)' }}>
        Powered by Chat Monitor
      </p>
    </Screen>
  );
};

// ── Shared styled sub-components ─────────────────────────────────────────────

const Screen = ({ children }: { children: React.ReactNode }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    const particles: { x: number; y: number; vx: number; vy: number; size: number; alpha: number; color: string }[] = [];
    const colors = ['#3b82f6', '#8b5cf6', '#06b6d4', '#6366f1'];
    for (let i = 0; i < 55; i++) {
      particles.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        size: Math.random() * 2 + 0.5,
        alpha: Math.random() * 0.5 + 0.1,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color + Math.floor(p.alpha * 255).toString(16).padStart(2, '0');
        ctx.fill();
      });
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 120) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(99,102,241,${0.12 * (1 - dist / 120)})`;
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      }
      animId = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden p-4"
      style={{ background: 'linear-gradient(135deg, #0a0e1a 0%, #0f172a 40%, #0d1b2e 70%, #090d1a 100%)' }}>
      <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />
      <div className="absolute inset-0 pointer-events-none" style={{
        background: 'radial-gradient(ellipse 60% 50% at 20% 30%, rgba(99,102,241,0.12) 0%, transparent 70%), radial-gradient(ellipse 50% 40% at 80% 70%, rgba(6,182,212,0.10) 0%, transparent 65%)',
      }} />
      <div className="relative z-10 w-full max-w-md">
        {children}
      </div>
    </div>
  );
};

const GlassCard = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-2xl p-7" style={{
    background: 'rgba(15,23,42,0.75)',
    backdropFilter: 'blur(24px)',
    border: '1px solid rgba(99,102,241,0.18)',
    boxShadow: '0 0 0 1px rgba(255,255,255,0.04), 0 24px 64px rgba(0,0,0,0.5), 0 0 40px rgba(99,102,241,0.06)',
  }}>
    {children}
  </div>
);

const DarkField = ({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) => (
  <div className={`space-y-1.5 ${className ?? ''}`}>
    <label className="text-sm font-medium" style={{ color: 'rgba(203,213,225,0.9)' }}>{label}</label>
    {children}
  </div>
);

const DarkInput = ({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input
    {...props}
    className={`w-full h-11 rounded-xl px-3.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-colors ${className ?? ''}`}
    style={{
      background: 'rgba(30,41,59,0.8)',
      border: '1px solid rgba(99,102,241,0.2)',
      ...((props as React.CSSProperties & typeof props).style ?? {}),
    }}
  />
);

const GradientButton = ({
  children, className, disabled, onClick, type = 'button',
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
}) => (
  <button
    type={type}
    disabled={disabled}
    onClick={onClick}
    className={`flex items-center justify-center gap-2 h-11 rounded-xl font-semibold text-white text-sm transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed ${className ?? ''}`}
    style={{
      background: disabled
        ? 'rgba(99,102,241,0.5)'
        : 'linear-gradient(135deg, #3b82f6 0%, #6366f1 50%, #8b5cf6 100%)',
      boxShadow: disabled ? 'none' : '0 4px 20px rgba(99,102,241,0.35)',
    }}
  >
    {children}
  </button>
);

const DarkButton = ({
  children, onClick, asLink, to,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  asLink?: boolean;
  to?: string;
}) => {
  const cls = 'flex items-center justify-center w-full h-11 rounded-xl font-semibold text-sm transition-all duration-200';
  const style = {
    background: 'linear-gradient(135deg, #3b82f6 0%, #6366f1 50%, #8b5cf6 100%)',
    boxShadow: '0 4px 20px rgba(99,102,241,0.35)',
    color: 'white',
  };
  if (asLink && to) {
    return <Link to={to} className={cls} style={style}>{children}</Link>;
  }
  return <button type="button" onClick={onClick} className={cls} style={style}>{children}</button>;
};

export default InviteAccept;
