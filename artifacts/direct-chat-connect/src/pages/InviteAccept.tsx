import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, ShieldCheck, ShieldAlert } from 'lucide-react';
import { setGuestSession } from '@/lib/guestSession';

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

  const [stage, setStage] = useState<'loading' | 'granting' | 'done' | 'error'>('loading');
  const [error, setError] = useState('');
  const [invite, setInvite] = useState<Invite | null>(null);

  useEffect(() => {
    if (!token) { navigate('/'); return; }
    handleInvite(token);
  }, [token]);

  const handleInvite = async (tok: string) => {
    try {
      const { data, error: rpcErr } = await supabase.rpc('get_invite_by_token', { p_token: tok });

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

      // Store guest session — no login required
      setGuestSession({
        token: row.token,
        role: row.role,
        permissions: row.permissions ?? [],
        email: row.email,
      });

      // Mark invite as accepted (no user_id since no auth)
      await supabase
        .from('team_invites')
        .update({ status: 'accepted' })
        .eq('token', tok);

      setStage('done');
      setTimeout(() => navigate('/'), 1200);
    } catch {
      setError('Something went wrong. Please try again.');
      setStage('error');
    }
  };

  // ── Loading / Validating ───────────────────────────────────────────────────
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

  // ── Granting / Done ───────────────────────────────────────────────────────
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

        {/* Permissions preview */}
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
