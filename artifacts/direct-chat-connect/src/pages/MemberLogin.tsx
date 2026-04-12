import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { signInMember, setMemberSession, getMemberSession, hashPassword } from '@/lib/memberAuth';
import {
  getStoredMemberProxyCreds, proxyLoginMember, storeMemberProxyCreds, type DbCreds,
} from '@/lib/memberAuthProxy';
import { getConnections, setActiveConnection, DB_TYPES, type MainDbType } from '@/lib/db-config';
import { LogIn, Database, Eye, EyeOff, ChevronDown, Link } from 'lucide-react';
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
        const newConn = { id: `subadmin-${Date.now()}`, name: 'My Database', dbType: 'supabase' as const, url: creds.url, anonKey: creds.anonKey, createdAt: new Date().toISOString() };
        localStorage.setItem('meta_db_connections', JSON.stringify([...existing, newConn]));
        connId = newConn.id;
      } else { connId = alreadyExists.id; }
      setActiveConnection(connId);
      localStorage.setItem(DB_SETTINGS_KEY, JSON.stringify({ db_type: 'supabase', supabase_url: creds.url, anon_key: creds.anonKey, service_role_key: creds.anonKey, table_name: 'n8n_chat_histories', is_active: true }));
    } else if (creds.dbType && creds.dbType !== 'supabase') {
      const proxyCreds: DbCreds = { dbType: creds.dbType as DbCreds['dbType'], host: creds.host, port: creds.port, dbUsername: creds.dbUsername, dbPassword: creds.dbPassword, dbName: creds.dbName, connectionString: creds.connectionString };
      storeMemberProxyCreds(proxyCreds);
      const existing = getConnections();
      const label = `${creds.dbType}://${creds.host || creds.connectionString?.slice(0, 20) || 'subadmin'}`;
      const alreadyExists = existing.find(c => c.connectionString === creds.connectionString && c.url === creds.host);
      let connId: string;
      if (!alreadyExists) {
        const newConn = { id: `subadmin-${Date.now()}`, name: label, dbType: creds.dbType as MainDbType, url: creds.host || '', anonKey: '', connectionString: creds.connectionString, host: creds.host, port: creds.port, dbUsername: creds.dbUsername, dbName: creds.dbName, createdAt: new Date().toISOString() };
        localStorage.setItem('meta_db_connections', JSON.stringify([...existing, newConn]));
        connId = newConn.id;
      } else { connId = alreadyExists.id; }
      setActiveConnection(connId);
    }
  } catch { /* ignore */ }
}

function ParticleCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let animId: number;
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    window.addEventListener('resize', resize);
    const colors = ['#3b82f6', '#8b5cf6', '#06b6d4', '#6366f1'];
    const particles = Array.from({ length: 55 }, () => ({
      x: Math.random() * window.innerWidth, y: Math.random() * window.innerHeight,
      vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4,
      size: Math.random() * 2 + 0.5, alpha: Math.random() * 0.5 + 0.1,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = canvas.width; if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height; if (p.y > canvas.height) p.y = 0;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color + Math.floor(p.alpha * 255).toString(16).padStart(2, '0');
        ctx.fill();
      });
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x, dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 120) {
            ctx.beginPath(); ctx.moveTo(particles[i].x, particles[i].y); ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(99,102,241,${0.12 * (1 - dist / 120)})`; ctx.lineWidth = 0.6; ctx.stroke();
          }
        }
      }
      animId = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(animId); window.removeEventListener('resize', resize); };
  }, []);
  return <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />;
}

const glassCard = {
  background: 'rgba(15,23,42,0.78)',
  backdropFilter: 'blur(24px)',
  border: '1px solid rgba(99,102,241,0.18)',
  boxShadow: '0 0 0 1px rgba(255,255,255,0.04), 0 24px 64px rgba(0,0,0,0.5), 0 0 40px rgba(99,102,241,0.06)',
  borderRadius: '18px',
};

const inputStyle = {
  background: 'rgba(30,41,59,0.8)',
  border: '1px solid rgba(99,102,241,0.2)',
  borderRadius: '10px',
  color: 'white',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: 'none' as const,
  width: '100%',
  height: '42px',
  padding: '0 2rem 0 0.75rem',
  fontSize: '0.875rem',
};

const GradientButton = ({ onClick, disabled, children, className = '' }: { onClick?: () => void; disabled?: boolean; children: React.ReactNode; className?: string }) => (
  <button
    type={onClick ? 'button' : 'submit'}
    onClick={onClick}
    disabled={disabled}
    className={cn('w-full h-11 rounded-xl font-semibold text-white text-sm transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed', className)}
    style={{ background: disabled ? 'rgba(99,102,241,0.5)' : 'linear-gradient(135deg,#3b82f6 0%,#6366f1 50%,#8b5cf6 100%)', boxShadow: disabled ? 'none' : '0 4px 20px rgba(99,102,241,0.35)' }}
  >
    {children}
  </button>
);

const DarkInput = ({ label, type = 'text', value, onChange, placeholder, rightEl }: { label: string; type?: string; value: string; onChange: (v: string) => void; placeholder?: string; rightEl?: React.ReactNode }) => (
  <div className="space-y-1.5">
    <label className="text-sm font-medium" style={{ color: 'rgba(203,213,225,0.9)' }}>{label}</label>
    <div className="relative">
      <Input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="h-11 pr-10 placeholder:text-slate-500 focus-visible:ring-1 focus-visible:ring-indigo-500"
        style={inputStyle} />
      {rightEl && <div className="absolute right-3 top-2.5">{rightEl}</div>}
    </div>
  </div>
);

const MemberLogin = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasCreds, setHasCreds] = useState(() => hasWorkspaceCreds());
  const [showOwnDbForm, setShowOwnDbForm] = useState(false);
  const [ownDbType, setOwnDbType] = useState<MainDbType>('supabase');
  const [ownUrl, setOwnUrl] = useState('');
  const [ownAnonKey, setOwnAnonKey] = useState('');
  const [ownShowKey, setOwnShowKey] = useState(false);
  const [ownHost, setOwnHost] = useState('');
  const [ownPort, setOwnPort] = useState('');
  const [ownUsername, setOwnUsername] = useState('');
  const [ownPassword, setOwnPassword] = useState('');
  const [ownDbName, setOwnDbName] = useState('');
  const [ownConnStr, setOwnConnStr] = useState('');
  const [ownSaving, setOwnSaving] = useState(false);

  useEffect(() => {
    setHasCreds(hasWorkspaceCreds());
    getMemberSession().then(session => {
      if (session?.role === 'sub-admin' && !localStorage.getItem(SUBADMIN_DB_KEY)) setShowOwnDbForm(true);
    });
  }, []);

  const ownNeedsConnStr = ownDbType === 'mongodb' || ownDbType === 'redis';
  const ownNeedsHostFields = ownDbType === 'postgresql' || ownDbType === 'mysql';
  const ownCurrentDbType = DB_TYPES.find(t => t.value === ownDbType);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) { toast.error('Please enter your email and password'); return; }
    setLoading(true);
    try {
      const proxyCreds = getStoredMemberProxyCreds();
      if (proxyCreds) {
        const hash = await hashPassword(password);
        const member = await proxyLoginMember(proxyCreds, email.toLowerCase().trim(), hash);
        if (!member) { toast.error('Invalid email or password, or your access has not been approved yet.'); return; }
        const isSelfDb = (member.role as string) === 'sub-admin';
        setMemberSession({ email: (member.submitted_email as string) || email.toLowerCase().trim(), displayName: (member.submitted_name as string) || email.split('@')[0], role: member.role as string, permissions: (member.permissions as string[]) || [], inviteId: member.id as string, isSelfDb });
        if (isSelfDb) { restoreSubAdminDb(); if (!localStorage.getItem(SUBADMIN_DB_KEY)) { setShowOwnDbForm(true); return; } }
        navigate('/'); return;
      }
      const { error } = await signInMember(email, password);
      if (error) {
        toast.error(error.message.toLowerCase().includes('invalid') ? 'Incorrect email or password. Your access may have been removed.' : error.message);
      } else {
        const session = await getMemberSession();
        if (session?.role === 'sub-admin') { restoreSubAdminDb(); if (!localStorage.getItem(SUBADMIN_DB_KEY)) { setShowOwnDbForm(true); return; } }
        navigate('/');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally { setLoading(false); }
  };

  const handleSaveOwnDb = async () => {
    setOwnSaving(true);
    try {
      let credsObj: Record<string, string>;
      if (ownDbType === 'supabase') {
        if (!ownUrl.trim() || !ownAnonKey.trim()) { toast.error('Please enter Supabase URL and Anon Key'); return; }
        credsObj = { dbType: 'supabase', url: ownUrl.trim(), anonKey: ownAnonKey.trim() };
      } else if (ownNeedsConnStr) {
        if (!ownConnStr.trim()) { toast.error('Please enter a connection string'); return; }
        credsObj = { dbType: ownDbType, connectionString: ownConnStr.trim() };
      } else {
        if (!ownHost.trim() || !ownUsername.trim()) { toast.error('Please enter host and username'); return; }
        credsObj = { dbType: ownDbType, host: ownHost.trim(), port: ownPort.trim(), dbUsername: ownUsername.trim(), dbPassword: ownPassword, dbName: ownDbName.trim() };
      }
      localStorage.setItem(SUBADMIN_DB_KEY, JSON.stringify(credsObj));
      restoreSubAdminDb();
      toast.success('Your database connected!');
      navigate('/');
    } catch { toast.error('Failed to save database credentials'); }
    finally { setOwnSaving(false); }
  };

  const pageWrapper = (children: React.ReactNode) => (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden p-4"
      style={{ background: 'linear-gradient(135deg,#0a0e1a 0%,#0f172a 40%,#0d1b2e 70%,#090d1a 100%)' }}>
      <ParticleCanvas />
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 60% 50% at 20% 30%,rgba(99,102,241,0.12) 0%,transparent 70%),radial-gradient(ellipse 50% 40% at 80% 70%,rgba(6,182,212,0.10) 0%,transparent 65%)' }} />
      <div className="relative z-10 w-full max-w-md space-y-4">{children}</div>
    </div>
  );

  const Logo = () => (
    <div className="text-center mb-6">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl mb-4"
        style={{ background: 'linear-gradient(135deg,#3b82f6,#8b5cf6)' }}>
        <LogIn size={22} className="text-white" />
      </div>
      <h1 className="text-2xl font-bold text-white tracking-tight">
        Chat <span style={{ background: 'linear-gradient(90deg,#3b82f6,#8b5cf6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Monitor</span>
      </h1>
      <p className="mt-1.5 text-sm" style={{ color: 'rgba(148,163,184,0.8)' }}>Sign in with your member account</p>
    </div>
  );

  if (showOwnDbForm) {
    return pageWrapper(
      <>
        <Logo />
        <div style={glassCard} className="p-7 space-y-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'rgba(139,92,246,0.2)', border: '1px solid rgba(139,92,246,0.3)' }}>
              <Database size={17} style={{ color: '#a78bfa' }} />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">Connect Your Database</p>
              <p className="text-xs" style={{ color: 'rgba(148,163,184,0.7)' }}>Sub-Admin — your own database</p>
            </div>
          </div>
          <div className="rounded-xl px-3.5 py-2.5" style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.2)' }}>
            <p className="text-[11px] leading-relaxed" style={{ color: 'rgba(196,181,253,0.9)' }}>As a Sub-Admin, you manage your own database. Connect it below to access your dashboard data.</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" style={{ color: 'rgba(203,213,225,0.9)' }}>Database Type</label>
            <div className="relative">
              <select value={ownDbType} onChange={e => setOwnDbType(e.target.value as MainDbType)} style={selectStyle} className="focus:outline-none focus:ring-1 focus:ring-indigo-500">
                {DB_TYPES.map(t => <option key={t.value} value={t.value}>{t.icon} {t.label}</option>)}
              </select>
              <ChevronDown size={12} className="absolute right-2.5 top-3.5 pointer-events-none" style={{ color: 'rgba(148,163,184,0.6)' }} />
            </div>
          </div>
          {ownDbType === 'supabase' && (<>
            <DarkInput label="Supabase Project URL" value={ownUrl} onChange={setOwnUrl} placeholder="https://xxx.supabase.co" />
            <DarkInput label="Anon Key" type={ownShowKey ? 'text' : 'password'} value={ownAnonKey} onChange={setOwnAnonKey} placeholder="eyJ..." rightEl={<button type="button" onClick={() => setOwnShowKey(s => !s)} style={{ color: 'rgba(148,163,184,0.7)' }}>{ownShowKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>} />
          </>)}
          {ownNeedsHostFields && (<>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2"><DarkInput label="Host" value={ownHost} onChange={setOwnHost} placeholder="localhost" /></div>
              <DarkInput label="Port" value={ownPort} onChange={setOwnPort} placeholder={ownCurrentDbType?.defaultPort || ''} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <DarkInput label="Username" value={ownUsername} onChange={setOwnUsername} placeholder="admin" />
              <DarkInput label="Password" type="password" value={ownPassword} onChange={setOwnPassword} placeholder="••••••••" />
            </div>
            <DarkInput label="Database Name" value={ownDbName} onChange={setOwnDbName} placeholder="my_database" />
          </>)}
          {ownNeedsConnStr && <DarkInput label="Connection String" value={ownConnStr} onChange={setOwnConnStr} placeholder={ownDbType === 'mongodb' ? 'mongodb://...' : 'redis://...'} />}
          <GradientButton onClick={handleSaveOwnDb} disabled={ownSaving}>{ownSaving ? 'Connecting…' : 'Connect My Database'}</GradientButton>
        </div>
      </>
    );
  }

  return pageWrapper(
    <>
      <Logo />

      <div style={glassCard} className="p-7">
        {!hasCreds ? (
          /* No workspace credentials stored on this device — show invite link message */
          <div className="space-y-5 text-center py-2">
            <div className="flex items-center justify-center">
              <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.25)' }}>
                <Link size={24} style={{ color: '#818cf8' }} />
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-base font-semibold text-white">Workspace not set up on this device</p>
              <p className="text-sm leading-relaxed" style={{ color: 'rgba(148,163,184,0.85)' }}>
                Please re-open your invite link to connect this device to the workspace.
              </p>
              <p className="text-xs leading-relaxed" style={{ color: 'rgba(100,116,139,0.8)' }}>
                If you no longer have your invite link, contact your admin to resend it.
              </p>
            </div>
          </div>
        ) : (
          /* Workspace credentials exist — show normal sign-in form */
          <form onSubmit={handleLogin} className="space-y-4">
            <DarkInput label="Email" type="email" value={email} onChange={setEmail} placeholder="Enter your email" />
            <DarkInput label="Password" type={showPassword ? 'text' : 'password'} value={password} onChange={setPassword} placeholder="Enter your password"
              rightEl={<button type="button" onClick={() => setShowPassword(s => !s)} style={{ color: 'rgba(148,163,184,0.7)' }}>{showPassword ? <EyeOff size={14} /> : <Eye size={14} />}</button>} />
            <GradientButton disabled={loading}>
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" /></svg>
                  Signing in…
                </span>
              ) : 'Sign In'}
            </GradientButton>
          </form>
        )}
        <p className="text-center text-xs mt-4" style={{ color: 'rgba(100,116,139,0.7)' }}>
          Don't have access yet? Ask your admin for an invite link.
        </p>
      </div>

      <p className="text-center text-xs" style={{ color: 'rgba(100,116,139,0.6)' }}>Powered by Chat Monitor</p>
    </>
  );
};

export default MemberLogin;
