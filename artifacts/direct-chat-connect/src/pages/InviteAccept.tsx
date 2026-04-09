import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { createClient } from '@supabase/supabase-js';
import { supabase as defaultSupabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, ShieldCheck, ShieldAlert } from 'lucide-react';
import { setGuestSession } from '@/lib/guestSession';
import { getConnections, setActiveConnection } from '@/lib/db-config';

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

  const [stage, setStage] = useState<'loading' | 'granting' | 'done' | 'error'>('loading');
  const [error, setError] = useState('');
  const [invite, setInvite] = useState<Invite | null>(null);

  useEffect(() => {
    if (!token) { navigate('/'); return; }
    handleInvite(token);
  }, [token]);

  const handleInvite = async (tok: string) => {
    try {
      // ── Decode Supabase credentials from URL params ────────────────────
      let supabaseUrl: string | null = null;
      let supabaseKey: string | null = null;

      const uParam = searchParams.get('u');
      const kParam = searchParams.get('k');
      const sParam = searchParams.get('s'); // service role key
      const tParam = searchParams.get('t'); // table name
      const nParam = searchParams.get('n'); // member name
      const pParam = searchParams.get('p'); // platform connections (base64 JSON)
      const qParam = searchParams.get('q'); // n8n settings (base64 JSON)

      let serviceRoleKey: string | null = null;
      let tableName: string | null = null;
      let memberName: string | null = null;
      let platformConnsJson: string | null = null;
      let n8nSettingsJson: string | null = null;

      if (uParam && kParam) {
        try {
          supabaseUrl = atob(decodeURIComponent(uParam));
          supabaseKey = atob(decodeURIComponent(kParam));
          if (sParam) serviceRoleKey = atob(decodeURIComponent(sParam));
          if (tParam) tableName = atob(decodeURIComponent(tParam));
          if (nParam) memberName = atob(decodeURIComponent(nParam));
          if (pParam) platformConnsJson = atob(decodeURIComponent(pParam));
          if (qParam) n8nSettingsJson = atob(decodeURIComponent(qParam));
        } catch {
          // ignore decode error — will fall back to default client
        }
      }

      // Use provided credentials or fall back to the already-configured client
      const client =
        supabaseUrl && supabaseKey
          ? createClient(supabaseUrl, supabaseKey)
          : defaultSupabase;

      // ── Validate the invite token ───────────────────────────────────────
      const { data, error: rpcErr } = await client.rpc('get_invite_by_token', { p_token: tok });

      if (rpcErr) {
        setError('Could not validate this invite link. Please check the link and try again.');
        setStage('error');
        return;
      }

      const row: Invite | null = Array.isArray(data) ? data[0] ?? null : data ?? null;

      if (!row) {
        setError('This invite link is invalid or has expired.');
        setStage('error');
        return;
      }
      if (row.status === 'revoked') {
        setError('This invite has been revoked. Please contact the admin for a new link.');
        setStage('error');
        return;
      }

      setInvite(row);
      setStage('granting');

      // ── Store Supabase connection in localStorage so dashboard works ────
      if (supabaseUrl && supabaseKey) {
        const existing = getConnections();
        const alreadyExists = existing.some(c => c.url === supabaseUrl);
        if (!alreadyExists) {
          const newConn = {
            id: `guest-${Date.now()}`,
            name: 'Invited Access',
            dbType: 'supabase' as const,
            url: supabaseUrl,
            anonKey: supabaseKey,
            ...(serviceRoleKey ? { serviceRoleKey } : {}),
            createdAt: new Date().toISOString(),
          };
          const updated = [...existing, newConn];
          localStorage.setItem('meta_db_connections', JSON.stringify(updated));
          setActiveConnection(newConn.id);
        } else {
          const match = existing.find(c => c.url === supabaseUrl)!;
          setActiveConnection(match.id);
        }

        // ── Also write to the legacy chat_monitor_db_settings key so
        //    data-fetching hooks (useChatHistory → externalDb) pick up creds ──
        const existingLegacy = (() => {
          try { return JSON.parse(localStorage.getItem(DB_SETTINGS_KEY) || 'null'); } catch { return null; }
        })();
        const legacyPayload = {
          ...(existingLegacy ?? {}),
          db_type: 'supabase',
          supabase_url: supabaseUrl,
          // Use service role key if provided, otherwise fall back to anon key
          service_role_key: serviceRoleKey ?? supabaseKey,
          // Preserve table_name from invite link or keep existing
          table_name: tableName ?? existingLegacy?.table_name ?? 'n8n_chat_histories',
          is_active: true,
        };
        localStorage.setItem(DB_SETTINGS_KEY, JSON.stringify(legacyPayload));

        // ── Copy platform connections (WhatsApp/Facebook/Instagram) ────────
        // Always overwrite so the invited user gets the latest tokens from admin
        if (platformConnsJson) {
          try {
            localStorage.setItem(PLATFORM_CONNS_KEY, platformConnsJson);
          } catch { /* ignore */ }
        }

        // ── Copy n8n settings ───────────────────────────────────────────────
        if (n8nSettingsJson) {
          try {
            if (!localStorage.getItem(N8N_SETTINGS_KEY)) {
              localStorage.setItem(N8N_SETTINGS_KEY, n8nSettingsJson);
            }
          } catch { /* ignore */ }
        }
      }

      // ── Store guest session ────────────────────────────────────────────
      // Name priority: URL param → invite.email → fallback
      const resolvedName = memberName || (row.email && !row.email.includes('@') ? row.email : null) || null;
      setGuestSession({
        token: row.token,
        role: row.role,
        permissions: row.permissions ?? [],
        email: row.email,
        ...(resolvedName ? { name: resolvedName } : {}),
      });

      // ── Mark invite accepted ───────────────────────────────────────────
      await client.from('team_invites').update({ status: 'accepted' }).eq('token', tok);

      setStage('done');
      // Full page reload so the Supabase client re-initialises with the new credentials
      setTimeout(() => { window.location.href = '/'; }, 1200);
    } catch {
      setError('Something went wrong. Please try again.');
      setStage('error');
    }
  };

  // ── Loading ────────────────────────────────────────────────────────────────
  if (stage === 'loading') {
    return (
      <Screen>
        <Loader2 size={28} className="animate-spin text-primary mx-auto" />
        <p className="text-sm text-muted-foreground text-center mt-3">Validating invite link…</p>
      </Screen>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (stage === 'error') {
    return (
      <Screen>
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center pb-2">
            <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-3">
              <ShieldAlert size={22} className="text-red-500" />
            </div>
            <CardTitle className="text-base">Invalid Invite</CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button onClick={() => navigate('/')} variant="outline" className="w-full">
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </Screen>
    );
  }

  // ── Granting / Done ────────────────────────────────────────────────────────
  const visiblePerms = (invite?.permissions ?? []).filter(p => p in PERMISSION_LABELS);

  return (
    <Screen>
      <div className="text-center space-y-5 max-w-sm w-full px-4">
        <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto transition-colors duration-500 ${
          stage === 'done' ? 'bg-emerald-500/10' : 'bg-primary/10'
        }`}>
          {stage === 'done'
            ? <ShieldCheck size={28} className="text-emerald-500" />
            : <Loader2 size={28} className="text-primary animate-spin" />
          }
        </div>

        <div>
          <p className="text-lg font-bold text-foreground">
            {stage === 'done' ? 'Access Granted!' : 'Setting up your access…'}
          </p>
          {invite && (
            <p className="text-sm text-muted-foreground mt-1">
              {stage === 'done'
                ? 'Redirecting to dashboard…'
                : `Role: ${invite.role === 'admin' ? 'Admin' : 'Viewer'}`}
            </p>
          )}
        </div>

        {invite?.role === 'viewer' && visiblePerms.length > 0 && (
          <div className="rounded-xl bg-muted/40 border border-border p-3 text-left space-y-2">
            <p className="text-xs font-semibold text-foreground">Pages you can access</p>
            <div className="flex flex-wrap gap-1.5">
              {visiblePerms.map(perm => (
                <span key={perm} className="text-[10px] font-semibold px-2.5 py-0.5 rounded-full bg-primary/10 text-primary">
                  {PERMISSION_LABELS[perm]}
                </span>
              ))}
            </div>
          </div>
        )}

        {stage === 'done' && (
          <Loader2 size={16} className="animate-spin text-muted-foreground mx-auto" />
        )}
      </div>
    </Screen>
  );
};

const Screen = ({ children }: { children: React.ReactNode }) => (
  <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4 gap-4">
    {children}
  </div>
);

export default InviteAccept;
