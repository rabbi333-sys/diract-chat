import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { toast } from 'sonner';
import { signInMember, setMemberSession, getMemberSession, hashPassword } from '@/lib/memberAuth';
import {
  getStoredMemberProxyCreds, proxyLoginMember, storeMemberProxyCreds, type DbCreds,
} from '@/lib/memberAuthProxy';
import { getConnections, setActiveConnection, DB_TYPES, type MainDbType } from '@/lib/db-config';
import { LogIn, Database, Eye, EyeOff, ChevronDown, CheckCircle2, Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const DB_SETTINGS_KEY = 'chat_monitor_db_settings';
const SUBADMIN_DB_KEY = 'meta_subadmin_db_creds';

function hasWorkspaceCreds(): boolean {
  try {
    const cfg = JSON.parse(localStorage.getItem(DB_SETTINGS_KEY) || 'null');
    if (cfg?.supabase_url && cfg.anon_key) return true;
  } catch { /* ignore */ }
  return !!getStoredMemberProxyCreds();
}

function restoreSubAdminDb(): void {
  try {
    const raw = localStorage.getItem(SUBADMIN_DB_KEY);
    if (!raw) return;
    const creds = JSON.parse(raw) as Record<string, string>;
    if (creds.dbType === 'supabase' && creds.url && creds.anonKey) {
      const existing = getConnections();
      const alreadyExists = existing.find(c => c.url === creds.url);
      let connId: string;
      if (!alreadyExists) {
        const newConn = {
          id: `subadmin-${Date.now()}`,
          name: 'My Database',
          dbType: 'supabase' as const,
          url: creds.url,
          anonKey: creds.anonKey,
          createdAt: new Date().toISOString(),
        };
        localStorage.setItem('meta_db_connections', JSON.stringify([...existing, newConn]));
        connId = newConn.id;
      } else {
        connId = alreadyExists.id;
      }
      setActiveConnection(connId);
      localStorage.setItem(DB_SETTINGS_KEY, JSON.stringify({
        db_type: 'supabase',
        supabase_url: creds.url,
        anon_key: creds.anonKey,
        service_role_key: creds.anonKey,
        table_name: 'n8n_chat_histories',
        is_active: true,
      }));
    } else if (creds.dbType && creds.dbType !== 'supabase') {
      storeMemberProxyCreds({
        dbType: creds.dbType as DbCreds['dbType'],
        host: creds.host,
        port: creds.port,
        dbUsername: creds.dbUsername,
        dbPassword: creds.dbPassword,
        dbName: creds.dbName,
        connectionString: creds.connectionString,
      });
    }
  } catch { /* ignore */ }
}

const MemberLogin = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const [wsConnected, setWsConnected] = useState(false);
  const [showWsForm, setShowWsForm] = useState(false);
  const [wsConnecting, setWsConnecting] = useState(false);
  const [wsDbType, setWsDbType] = useState<MainDbType>('supabase');
  const [wsUrl, setWsUrl] = useState('');
  const [wsAnonKey, setWsAnonKey] = useState('');
  const [wsShowAnonKey, setWsShowAnonKey] = useState(false);
  const [wsHost, setWsHost] = useState('');
  const [wsPort, setWsPort] = useState('');
  const [wsUsername, setWsUsername] = useState('');
  const [wsPassword, setWsPassword] = useState('');
  const [wsDbName, setWsDbName] = useState('');
  const [wsConnStr, setWsConnStr] = useState('');

  useEffect(() => {
    const connected = hasWorkspaceCreds();
    setWsConnected(connected);
    if (!connected) setShowWsForm(true);
  }, []);

  const handleConnectWorkspace = async () => {
    setWsConnecting(true);
    try {
      if (wsDbType === 'supabase') {
        if (!wsUrl.trim() || !wsAnonKey.trim()) {
          toast.error('Please enter Supabase URL and Anon Key');
          return;
        }
        localStorage.setItem(DB_SETTINGS_KEY, JSON.stringify({
          db_type: 'supabase',
          supabase_url: wsUrl.trim(),
          anon_key: wsAnonKey.trim(),
          service_role_key: wsAnonKey.trim(),
          table_name: 'n8n_chat_histories',
          is_active: true,
        }));
        const existing = getConnections();
        const alreadyExists = existing.find(c => c.url === wsUrl.trim());
        if (!alreadyExists) {
          const newConn = {
            id: `member-ws-${Date.now()}`,
            name: 'Workspace',
            dbType: 'supabase' as const,
            url: wsUrl.trim(),
            anonKey: wsAnonKey.trim(),
            createdAt: new Date().toISOString(),
          };
          localStorage.setItem('meta_db_connections', JSON.stringify([...existing, newConn]));
          setActiveConnection(newConn.id);
        } else {
          setActiveConnection(alreadyExists.id);
        }
      } else {
        const needsConnStr = wsDbType === 'mongodb' || wsDbType === 'redis';
        if (needsConnStr && !wsConnStr.trim()) {
          toast.error('Please enter a connection string');
          return;
        }
        if (!needsConnStr && (!wsHost.trim() || !wsUsername.trim())) {
          toast.error('Please enter host and username');
          return;
        }
        const creds: DbCreds = {
          dbType: wsDbType,
          host: wsHost.trim() || undefined,
          port: wsPort.trim() || undefined,
          dbUsername: wsUsername.trim() || undefined,
          dbPassword: wsPassword || undefined,
          dbName: wsDbName.trim() || undefined,
          connectionString: wsConnStr.trim() || undefined,
        };
        storeMemberProxyCreds(creds);
      }
      setWsConnected(true);
      setShowWsForm(false);
      toast.success('Workspace connected! You can now sign in.');
    } finally {
      setWsConnecting(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) { toast.error('Please enter your email and password'); return; }
    setLoading(true);
    try {
      const proxyCreds = getStoredMemberProxyCreds();
      if (proxyCreds) {
        const hash = await hashPassword(password);
        const member = await proxyLoginMember(proxyCreds, email.toLowerCase().trim(), hash);
        if (!member) {
          toast.error('Invalid email or password, or your access has not been approved yet.');
          return;
        }
        const isSelfDb = (member.role as string) === 'sub-admin';
        setMemberSession({
          email: (member.submitted_email as string) || email.toLowerCase().trim(),
          displayName: (member.submitted_name as string) || email.split('@')[0],
          role: member.role as string,
          permissions: (member.permissions as string[]) || [],
          inviteId: member.id as string,
          isSelfDb,
        });
        if (isSelfDb) restoreSubAdminDb();
        navigate('/');
        return;
      }

      const { error } = await signInMember(email, password);
      if (error) {
        if (error.message.toLowerCase().includes('invalid')) {
          toast.error('Incorrect email or password. Your access may have been removed.');
        } else {
          toast.error(error.message);
        }
      } else {
        const session = await getMemberSession();
        if (session?.role === 'sub-admin') restoreSubAdminDb();
        navigate('/');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const currentDbType = DB_TYPES.find(t => t.value === wsDbType);
  const needsConnStr = wsDbType === 'mongodb' || wsDbType === 'redis';
  const needsHostFields = wsDbType === 'postgresql' || wsDbType === 'mysql';

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-4">

        {/* Workspace Connect Section */}
        {showWsForm && (
          <Card className="shadow-lg border-primary/20">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Database size={17} className="text-primary" />
                </div>
                <div>
                  <CardTitle className="text-base">Connect Workspace</CardTitle>
                  <CardDescription className="text-xs">Enter your workspace database credentials</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200/60 dark:border-blue-800/40 px-3.5 py-2.5">
                <p className="text-[11px] text-blue-700 dark:text-blue-300 leading-relaxed">
                  First time on this device? Enter your workspace credentials below. After saving, these will be remembered for future logins.
                </p>
              </div>

              {/* DB Type */}
              <div className="space-y-1.5">
                <Label className="text-xs">Database Type</Label>
                <div className="relative">
                  <select
                    value={wsDbType}
                    onChange={e => setWsDbType(e.target.value as MainDbType)}
                    className="w-full appearance-none h-9 rounded-xl border border-border/60 bg-muted/30 px-3 pr-8 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary/40 transition-colors"
                  >
                    {DB_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{t.icon} {t.label}</option>
                    ))}
                  </select>
                  <ChevronDown size={12} className="absolute right-2.5 top-2.5 text-muted-foreground pointer-events-none" />
                </div>
              </div>

              {/* Supabase fields */}
              {wsDbType === 'supabase' && (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Supabase Project URL</Label>
                    <Input
                      value={wsUrl}
                      onChange={e => setWsUrl(e.target.value)}
                      placeholder="https://xxx.supabase.co"
                      className="h-9 text-sm rounded-xl"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Anon Key</Label>
                    <div className="relative">
                      <Input
                        type={wsShowAnonKey ? 'text' : 'password'}
                        value={wsAnonKey}
                        onChange={e => setWsAnonKey(e.target.value)}
                        placeholder="eyJ..."
                        className="h-9 text-sm rounded-xl pr-9"
                      />
                      <button
                        type="button"
                        onClick={() => setWsShowAnonKey(s => !s)}
                        className="absolute right-2.5 top-2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {wsShowAnonKey ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {/* PostgreSQL / MySQL fields */}
              {needsHostFields && (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2 space-y-1.5">
                      <Label className="text-xs">Host</Label>
                      <Input value={wsHost} onChange={e => setWsHost(e.target.value)} placeholder="localhost" className="h-9 text-sm rounded-xl" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Port</Label>
                      <Input value={wsPort} onChange={e => setWsPort(e.target.value)} placeholder={currentDbType?.defaultPort || ''} className="h-9 text-sm rounded-xl" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Username</Label>
                      <Input value={wsUsername} onChange={e => setWsUsername(e.target.value)} placeholder="root" className="h-9 text-sm rounded-xl" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Password</Label>
                      <Input type="password" value={wsPassword} onChange={e => setWsPassword(e.target.value)} placeholder="••••••••" className="h-9 text-sm rounded-xl" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Database Name</Label>
                    <Input value={wsDbName} onChange={e => setWsDbName(e.target.value)} placeholder="mydb" className="h-9 text-sm rounded-xl" />
                  </div>
                </>
              )}

              {/* MongoDB / Redis connection string */}
              {needsConnStr && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Connection String</Label>
                  <Input
                    value={wsConnStr}
                    onChange={e => setWsConnStr(e.target.value)}
                    placeholder={wsDbType === 'mongodb' ? 'mongodb+srv://...' : 'redis://...'}
                    className="h-9 text-sm rounded-xl"
                  />
                </div>
              )}

              <Button onClick={handleConnectWorkspace} disabled={wsConnecting} className="w-full h-9 text-sm rounded-xl gap-2">
                {wsConnecting ? 'Connecting…' : <><Link2 size={13} /> Save Workspace</>}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Login Card */}
        <Card className="shadow-lg">
          <CardHeader className="text-center pb-2">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
              <LogIn size={22} className="text-primary" />
            </div>
            <CardTitle className="text-2xl font-bold">
              Meta <span className="text-primary">Automation</span>
            </CardTitle>
            <CardDescription>Sign in with your member account</CardDescription>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">

            {/* Workspace status badge */}
            <div className={cn(
              'flex items-center gap-2 px-3 py-2 rounded-xl text-xs border',
              wsConnected
                ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-700 dark:text-emerald-400'
                : 'bg-amber-500/5 border-amber-500/20 text-amber-700 dark:text-amber-400'
            )}>
              {wsConnected
                ? <><CheckCircle2 size={12} className="flex-shrink-0" /> Workspace connected — enter your credentials below</>
                : <><Database size={12} className="flex-shrink-0" /> No workspace connected yet — fill in your database details above first</>
              }
              {wsConnected && (
                <button
                  onClick={() => setShowWsForm(s => !s)}
                  className="ml-auto text-[10px] underline opacity-60 hover:opacity-100 flex-shrink-0"
                >
                  {showWsForm ? 'Hide' : 'Change'}
                </button>
              )}
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  required
                  autoComplete="email"
                  disabled={!wsConnected}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Your password"
                    required
                    autoComplete="current-password"
                    disabled={!wsConnected}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(s => !s)}
                    className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <Button type="submit" className="w-full" disabled={loading || !wsConnected}>
                {loading ? 'Signing in…' : 'Sign In'}
              </Button>
            </form>

            {!wsConnected && (
              <p className="text-xs text-center text-muted-foreground">
                Connect your workspace above to enable sign in.
              </p>
            )}
            {wsConnected && (
              <p className="text-xs text-center text-muted-foreground">
                Don't have access yet? Ask your admin for an invite link.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default MemberLogin;
