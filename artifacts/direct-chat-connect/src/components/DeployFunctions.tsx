import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Rocket, Eye, EyeOff, CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight, ExternalLink, Key } from 'lucide-react';
import { getActiveConnection } from '@/lib/db-config';
import { toast } from 'sonner';

import checkAiStatusCode from '../../supabase/functions/check-ai-status/index.ts?raw';
import createConfirmedUserCode from '../../supabase/functions/create-confirmed-user/index.ts?raw';
import getChatHistoryCode from '../../supabase/functions/get-chat-history/index.ts?raw';
import humanHandoffCode from '../../supabase/functions/human-handoff/index.ts?raw';
import logFailureCode from '../../supabase/functions/log-failure/index.ts?raw';
import n8nProxyCode from '../../supabase/functions/n8n-proxy/index.ts?raw';
import receiveAiMessageCode from '../../supabase/functions/receive-ai-message/index.ts?raw';
import receiveHumanMessageCode from '../../supabase/functions/receive-human-message/index.ts?raw';
import receiveOrderCode from '../../supabase/functions/receive-order/index.ts?raw';
import sendInviteEmailCode from '../../supabase/functions/send-invite-email/index.ts?raw';
import sendReplyCode from '../../supabase/functions/send-reply/index.ts?raw';

function getProjectRef(): string {
  const conn = getActiveConnection();
  if (!conn?.url) return '';
  try {
    const hostname = new URL(conn.url.trim()).hostname;
    return hostname.split('.')[0] ?? '';
  } catch {
    return '';
  }
}
const MGMT_BASE = '/api/supabase-mgmt/v1';

const FUNCTIONS = [
  { slug: 'human-handoff',        name: 'Human Handoff',         code: humanHandoffCode,        verify_jwt: false },
  { slug: 'log-failure',          name: 'Log Failure',            code: logFailureCode,          verify_jwt: false },
  { slug: 'receive-order',        name: 'Receive Order',          code: receiveOrderCode,        verify_jwt: false },
  { slug: 'receive-ai-message',   name: 'Receive AI Message',     code: receiveAiMessageCode,    verify_jwt: false },
  { slug: 'receive-human-message',name: 'Receive Human Message',  code: receiveHumanMessageCode, verify_jwt: false },
  { slug: 'send-reply',           name: 'Send Reply',             code: sendReplyCode,           verify_jwt: false },
  { slug: 'check-ai-status',      name: 'Check AI Status',        code: checkAiStatusCode,       verify_jwt: false },
  { slug: 'get-chat-history',     name: 'Get Chat History',       code: getChatHistoryCode,      verify_jwt: false },
  { slug: 'n8n-proxy',            name: 'n8n Proxy',              code: n8nProxyCode,            verify_jwt: false },
  { slug: 'create-confirmed-user',name: 'Create Confirmed User',  code: createConfirmedUserCode, verify_jwt: false },
  { slug: 'send-invite-email',    name: 'Send Invite Email',      code: sendInviteEmailCode,     verify_jwt: false },
];

type DeployStatus = 'idle' | 'pending' | 'success' | 'error';

interface FnStatus {
  status: DeployStatus;
  message?: string;
}

const TOKEN_KEY = 'meta_supa_access_token';

export default function DeployFunctions() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? '');
  const [showToken, setShowToken] = useState(false);
  const [open, setOpen] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, FnStatus>>({});
  const [done, setDone] = useState(false);

  const saveToken = (val: string) => {
    setToken(val);
    if (val) localStorage.setItem(TOKEN_KEY, val);
    else localStorage.removeItem(TOKEN_KEY);
  };

  const deployAll = async () => {
    const projectRef = getProjectRef();
    if (!token.trim() || !projectRef) {
      if (!projectRef) toast.error('Connect your Supabase database first — project ref is needed.');
      return;
    }
    setDeploying(true);
    setDone(false);
    const next: Record<string, FnStatus> = {};
    FUNCTIONS.forEach(f => { next[f.slug] = { status: 'pending' }; });
    setStatuses({ ...next });

    for (const fn of FUNCTIONS) {
      try {
        const base = `${MGMT_BASE}/projects/${projectRef}/functions`;
        const headers = {
          'Authorization': `Bearer ${token.trim()}`,
          'Content-Type': 'application/json',
        };

        const checkRes = await fetch(`${base}/${fn.slug}`, { headers });
        const exists = checkRes.ok;

        const body = JSON.stringify({
          slug: fn.slug,
          name: fn.name,
          body: fn.code,
          verify_jwt: fn.verify_jwt,
        });

        const res = await fetch(
          exists ? `${base}/${fn.slug}` : base,
          { method: exists ? 'PATCH' : 'POST', headers, body }
        );

        if (res.ok) {
          next[fn.slug] = { status: 'success' };
        } else {
          const err = await res.json().catch(() => ({ message: res.statusText }));
          next[fn.slug] = { status: 'error', message: err?.message ?? 'Unknown error' };
        }
      } catch (e: unknown) {
        next[fn.slug] = { status: 'error', message: e instanceof Error ? e.message : 'Network error' };
      }
      setStatuses({ ...next });
    }

    setDeploying(false);
    setDone(true);
  };

  const successCount = Object.values(statuses).filter(s => s.status === 'success').length;
  const errorCount   = Object.values(statuses).filter(s => s.status === 'error').length;

  return (
    <div className="rounded-2xl border border-border bg-gradient-to-br from-muted/30 to-muted/10 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-5 py-4 border-b border-border/50 flex items-center gap-3 hover:bg-muted/30 transition-colors text-left"
        data-testid="button-toggle-deploy"
      >
        <div className="h-9 w-9 rounded-xl bg-violet-500/10 flex items-center justify-center flex-shrink-0">
          <Rocket size={18} className="text-violet-500" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">Deploy Edge Functions</h3>
          <p className="text-[11px] text-muted-foreground">
            Deploy all Supabase webhook functions in one click using your token
          </p>
        </div>
        {open ? <ChevronDown size={15} className="text-muted-foreground" /> : <ChevronRight size={15} className="text-muted-foreground" />}
      </button>

      {open && (
        <div className="p-5 space-y-4 animate-in slide-in-from-top-2 duration-200">

          {/* Instructions */}
          <div className="flex items-start gap-2 p-3 rounded-xl bg-violet-500/8 border border-violet-500/20">
            <ExternalLink size={13} className="text-violet-500 mt-0.5 flex-shrink-0" />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              To get an Access Token, go to:{' '}
              <a
                href="https://supabase.com/dashboard/account/tokens"
                target="_blank"
                rel="noreferrer"
                className="text-violet-500 underline underline-offset-2 font-medium"
              >
                supabase.com/dashboard/account/tokens
              </a>
              {' '}→ Click <strong>"Generate new token"</strong> → paste it below.
            </p>
          </div>

          {/* Token input */}
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 block">
              Personal Access Token
            </label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Key size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type={showToken ? 'text' : 'password'}
                  value={token}
                  onChange={e => saveToken(e.target.value)}
                  placeholder="sbp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  className="w-full pl-8 pr-3 py-2.5 rounded-xl border border-border bg-background text-xs font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500/50"
                  data-testid="input-supa-access-token"
                />
              </div>
              <Button
                variant="outline" size="icon" className="h-10 w-10 rounded-xl flex-shrink-0"
                onClick={() => setShowToken(s => !s)}
                data-testid="button-toggle-token-visibility"
              >
                {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1 ml-1">
              Token is saved locally and never sent anywhere.
            </p>
          </div>

          {/* Project ref indicator */}
          {(() => {
            const ref = getProjectRef();
            return ref ? (
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-500/8 border border-emerald-500/20">
                <span className="text-[10px] text-muted-foreground">Target project:</span>
                <code className="text-[10px] font-mono text-emerald-600 font-semibold">{ref}.supabase.co</code>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500/8 border border-amber-500/20">
                <span className="text-[10px] text-amber-600">⚠ No Supabase database connected. Connect one first in the DB settings.</span>
              </div>
            );
          })()}

          {/* Deploy button */}
          <Button
            className="w-full rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-semibold text-sm h-10 gap-2"
            onClick={deployAll}
            disabled={!token.trim() || deploying || !getProjectRef()}
            data-testid="button-deploy-all-functions"
          >
            {deploying ? (
              <><Loader2 size={15} className="animate-spin" /> Deploying...</>
            ) : (
              <><Rocket size={15} /> Deploy All {FUNCTIONS.length} Functions</>
            )}
          </Button>

          {/* Status list */}
          {Object.keys(statuses).length > 0 && (
            <div className="space-y-1.5">
              {done && (
                <div className={`text-xs font-semibold px-3 py-2 rounded-xl mb-2 ${
                  errorCount === 0
                    ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20'
                    : 'bg-amber-500/10 text-amber-600 border border-amber-500/20'
                }`}>
                  {errorCount === 0
                    ? `✓ All ${successCount} functions deployed successfully!`
                    : `${successCount} success, ${errorCount} failed`}
                </div>
              )}
              {FUNCTIONS.map(fn => {
                const st = statuses[fn.slug];
                if (!st) return null;
                return (
                  <div
                    key={fn.slug}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-background border border-border/50"
                    data-testid={`status-fn-${fn.slug}`}
                  >
                    {st.status === 'pending' && <Loader2 size={13} className="text-muted-foreground animate-spin flex-shrink-0" />}
                    {st.status === 'success' && <CheckCircle2 size={13} className="text-emerald-500 flex-shrink-0" />}
                    {st.status === 'error'   && <XCircle size={13} className="text-destructive flex-shrink-0" />}
                    <span className="text-xs font-mono flex-1">{fn.slug}</span>
                    {st.status === 'error' && (
                      <span className="text-[10px] text-destructive truncate max-w-[140px]">{st.message}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
