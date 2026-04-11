import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertTriangle, CheckCircle, Clock, User, Bell, Webhook,
  MessageSquare,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { getLocalNames, useSessions } from '@/hooks/useChatHistory';

interface HandoffRequest {
  id: string;
  session_id: string | null;
  sender_id: string | null;
  recipient: string | null;
  reason: string;
  message: string | null;
  status: string;
  priority: string;
  agent_data: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  notes: string | null;
  _source?: 'local' | 'supabase';
}

// ─── Auto-disable AI for a session ───────────────────────────────────────────
// Does NOT pass user_id — the ai_control table (from FULL_SETUP_SQL) has no
// user_id column and uses an "Allow all" RLS policy. Passing user_id causes a
// silent schema error that prevents the upsert from succeeding.
async function autoDisableAi(session_id: string): Promise<boolean> {
  if (!session_id) return false;
  try {
    const { error } = await supabase.from('ai_control').upsert(
      { session_id, ai_enabled: false, updated_at: new Date().toISOString() },
      { onConflict: 'session_id' }
    );
    return !error;
  } catch {
    return false;
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────────
const useLocalHandoffs = () => {
  return useQuery({
    queryKey: ['local-handoffs'],
    retry: false,
    refetchInterval: 5000,
    queryFn: async (): Promise<HandoffRequest[]> => {
      try {
        const res = await fetch('/api/local/handoffs');
        if (!res.ok) return [];
        const data = await res.json();
        return (Array.isArray(data) ? data : []).map((d: HandoffRequest) => ({ ...d, _source: 'local' as const }));
      } catch {
        return [];
      }
    },
  });
};

const useSupabaseHandoffs = () => {
  return useQuery({
    queryKey: ['supabase-handoffs'],
    retry: false,
    refetchInterval: 3000,
    queryFn: async (): Promise<HandoffRequest[]> => {
      try {
        const { data, error } = await supabase
          .from('handoff_requests' as any)
          .select('*')
          .order('created_at', { ascending: false });
        if (error) return [];
        return ((data ?? []) as unknown as HandoffRequest[]).map(d => ({ ...d, _source: 'supabase' as const }));
      } catch {
        return [];
      }
    },
  });
};

function mergeHandoffs(local: HandoffRequest[], remote: HandoffRequest[]): HandoffRequest[] {
  const seen = new Set<string>();
  const result: HandoffRequest[] = [];
  for (const item of [...local, ...remote]) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      result.push(item);
    }
  }
  return result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

// ─── Component ────────────────────────────────────────────────────────────────
export const HandoffPanel = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: localHandoffs = [] } = useLocalHandoffs();
  const { data: supabaseHandoffs = [] } = useSupabaseHandoffs();
  const requests = mergeHandoffs(localHandoffs, supabaseHandoffs);
  const { data: sessions = [] } = useSessions();

  const [filter, setFilter] = useState<'all' | 'pending' | 'resolved'>('pending');

  // Keep a ref to the latest sessions so the realtime callback (closed over
  // an empty deps array) can still resolve the real session_id.
  const sessionsRef = useRef(sessions);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);

  // Track which session IDs we've already auto-disabled AI for (avoid repeat calls)
  const aiDisabledRef = useRef<Set<string>>(new Set());

  // ── Resolve the canonical session_id for a handoff ────────────────────────
  // Handoff rows may only carry sender_id (the Meta user ID). Look it up in the
  // sessions cache to find the real session_id that matches the DB + ai_control.
  function resolveRealSessionId(
    req: Pick<HandoffRequest, 'session_id' | 'sender_id' | 'recipient'>,
    sessionList: typeof sessions
  ): string | null {
    const candidate = req.sender_id || req.recipient;
    const matched = sessionList.find(
      s => s.recipient === candidate ||
           s.session_id === req.session_id ||
           s.session_id === req.sender_id
    );
    return matched?.session_id || req.session_id || req.sender_id || null;
  }

  // ── Disable AI: write to DB + pre-seed React Query cache ─────────────────
  function disableAiForSession(sid: string) {
    // Immediately reflect in UI (no waiting for DB round-trip)
    queryClient.cancelQueries({ queryKey: ['ai-control', sid] });
    queryClient.setQueryData(['ai-control', sid], false);
    // Persist to DB
    autoDisableAi(sid).then(ok => {
      if (!ok) aiDisabledRef.current.delete(sid);
      else queryClient.invalidateQueries({ queryKey: ['ai-control', sid] });
    });
  }

  // ── Auto-disable AI for all pending handoffs on load / change ──────────────
  useEffect(() => {
    for (const req of requests) {
      if (req.status !== 'pending') continue;
      const sid = resolveRealSessionId(req, sessions);
      if (sid && !aiDisabledRef.current.has(sid)) {
        aiDisabledRef.current.add(sid);
        disableAiForSession(sid);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests]);

  // ── Supabase realtime — also auto-disable AI on new INSERT ────────────────
  useEffect(() => {
    const channel = supabase
      .channel('handoff-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'handoff_requests' },
        (payload) => {
          queryClient.invalidateQueries({ queryKey: ['supabase-handoffs'] });
          const newRow = payload.new as HandoffRequest | undefined;
          if (!newRow) return;

          const sid = resolveRealSessionId(newRow, sessionsRef.current);

          if (sid && newRow.status === 'pending') {
            // INSERT = brand-new handoff: always re-disable even if user turned
            // AI back on manually after a previous request from this session.
            if (payload.eventType === 'INSERT') {
              aiDisabledRef.current.delete(sid);
            }
            if (!aiDisabledRef.current.has(sid)) {
              aiDisabledRef.current.add(sid);
              disableAiForSession(sid);
            }
          }

          // When resolved, clear from Set so a future request triggers fresh disable.
          if (newRow.status === 'resolved' && sid) {
            aiDisabledRef.current.delete(sid);
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient]);

  const resolveMutation = useMutation({
    mutationFn: async ({ id, status, source }: { id: string; status: string; source?: string }) => {
      const payload = { status, resolved_at: new Date().toISOString(), notes: null };

      if (source === 'local') {
        const res = await fetch(`/api/local/handoffs/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('Failed to update local handoff');
        return;
      }

      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('handoff_requests' as any)
        .update({ status, resolved_at: new Date().toISOString(), resolved_by: user?.id, notes: null })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['local-handoffs'] });
      queryClient.invalidateQueries({ queryKey: ['supabase-handoffs'] });
      toast.success('Request updated!');
    },
  });

  const filtered = requests.filter(r => {
    if (filter === 'pending') return r.status === 'pending';
    if (filter === 'resolved') return r.status !== 'pending';
    return true;
  });

  const pendingCount = requests.filter(r => r.status === 'pending').length;
  const localCount = localHandoffs.filter(r => r.status === 'pending').length;

  const getPriorityConfig = (priority: string) => {
    switch (priority) {
      case 'urgent': return { bg: 'bg-destructive', text: 'text-destructive-foreground', label: 'URGENT' };
      case 'high':   return { bg: 'bg-destructive/15', text: 'text-destructive', label: 'HIGH' };
      default:       return { bg: 'bg-muted', text: 'text-muted-foreground', label: priority?.toUpperCase() || 'NORMAL' };
    }
  };

  // Resolve customer name from local cache.
  // Prefer sender_id lookup (Facebook user ID) then fall back to recipient string.
  const localNames = getLocalNames();
  function resolveName(req: HandoffRequest): string {
    if (req.sender_id && localNames[req.sender_id]) return localNames[req.sender_id];
    if (req.recipient && localNames[req.recipient]) return localNames[req.recipient];
    return req.sender_id || req.recipient || 'Unknown';
  }

  // Navigate to the conversation for this handoff via the live inbox (Messages tab).
  function openChat(req: HandoffRequest, e: React.MouseEvent) {
    e.stopPropagation();

    // ── Resolve the best session_id ──────────────────────────────────────────
    // Handoff `session_id` may be null or a raw sender_id that doesn't match the
    // messages table. Look up the real session by matching recipient in the
    // sessions cache, then fall back to the handoff fields.
    const candidateRecipient = req.sender_id || req.recipient;
    const matchedSession = sessions.find(
      s => s.recipient === candidateRecipient ||
           s.session_id === req.session_id ||
           s.session_id === req.sender_id
    );
    const navSessionId = matchedSession?.session_id
      || req.session_id
      || req.sender_id;

    if (!navSessionId) {
      toast.error('No session ID on this handoff — cannot open conversation');
      return;
    }

    // ── Pre-seed AI=OFF in cache before navigation ────────────────────────────
    queryClient.cancelQueries({ queryKey: ['ai-control', navSessionId] });
    queryClient.setQueryData(['ai-control', navSessionId], false);

    // ── Auto-resolve the handoff request ─────────────────────────────────────
    if (req.status === 'pending') {
      resolveMutation.mutate({ id: req.id, status: 'resolved', source: req._source });
    }

    // ── Navigate to root with params — Index.tsx will switch to Messages tab ─
    // and immediately open the conversation. This keeps the user in the main
    // layout (live inbox) instead of the standalone /conversation/ page.
    const recipientParam = matchedSession?.recipient || candidateRecipient;
    const qs = new URLSearchParams({ openSession: navSessionId, disable_ai: '1' });
    if (recipientParam) qs.set('recipient', recipientParam);
    navigate(`/?${qs.toString()}`);
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Local webhook badge */}
      {localCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-primary/8 border border-primary/20">
          <Webhook size={13} className="text-primary flex-shrink-0" />
          <p className="text-[11px] text-muted-foreground">
            <span className="text-primary font-semibold">{localCount} new</span> handoffs received via webhook — AI auto-disabled
          </p>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex bg-muted/50 rounded-2xl p-1 border border-border/50">
        {(['pending', 'resolved', 'all'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            className={cn(
              "flex-1 text-xs font-semibold py-2.5 rounded-xl transition-all capitalize",
              filter === tab
                ? "bg-primary text-primary-foreground shadow-md shadow-primary/20"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab}
            {tab === 'pending' && pendingCount > 0 && (
              <span className="ml-1 inline-flex items-center justify-center h-5 w-5 rounded-full bg-primary-foreground/20 text-[10px]">
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide pr-1 space-y-3">
        {filtered.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <div className="h-16 w-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
              <Bell size={28} className="opacity-40" />
            </div>
            <p className="text-sm font-medium">No {filter === 'all' ? '' : filter} requests</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Requests will appear here in real-time</p>
          </div>
        )}

        {filtered.map((req) => {
          const priorityCfg = getPriorityConfig(req.priority);
          const customerName = resolveName(req);
          // sender_id serves as session_id on Meta platforms — treat either as valid
          const hasSession = !!req.session_id || !!req.sender_id;

          return (
            <div
              key={req.id}
              className={cn(
                "w-full text-left rounded-2xl border transition-all duration-200 overflow-hidden",
                req.status === 'pending'
                  ? "border-primary/20 bg-gradient-to-r from-primary/[0.03] to-transparent"
                  : "border-border bg-muted/20"
              )}
            >
              {/* ── Card header (clickable → open conversation) ──────────── */}
              {/* Using div to avoid nesting <button> inside <button> (invalid HTML) */}
              <div
                role="button"
                tabIndex={hasSession ? 0 : -1}
                className={cn(
                  "w-full text-left p-4 transition-all duration-150",
                  req.status === 'pending'
                    ? "hover:from-primary/[0.06] hover:shadow-sm"
                    : "hover:bg-muted/40",
                  hasSession ? "cursor-pointer" : "cursor-default"
                )}
                onClick={(e) => hasSession && openChat(req, e)}
                onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && hasSession) openChat(req, e as any); }}
                title={hasSession ? `Open conversation with ${customerName}` : 'No session ID — cannot navigate'}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className={cn(
                      "h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5",
                      req.status === 'pending' ? "bg-amber-500/10" : "bg-green-500/10"
                    )}>
                      {req.status === 'pending'
                        ? <AlertTriangle size={18} className="text-amber-500" />
                        : <CheckCircle size={18} className="text-green-500" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="font-semibold text-sm text-foreground leading-tight">{req.reason}</p>
                        {req._source === 'local' && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded-md flex-shrink-0">
                            <Webhook size={8} /> LIVE
                          </span>
                        )}
                      </div>
                      {/* Last message preview */}
                      {(req.message || req.reason) && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                          "{req.message || req.reason}"
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Right actions: priority badge + open chat button */}
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    <Badge className={cn(
                      "text-[10px] font-bold tracking-wide px-2.5 py-1 rounded-lg",
                      priorityCfg.bg, priorityCfg.text
                    )}>
                      {priorityCfg.label}
                    </Badge>

                    {/* Open Chat button — primary CTA on pending cards */}
                    {req.status === 'pending' && (
                      <button
                        onClick={(e) => openChat(req, e)}
                        disabled={!hasSession}
                        title={hasSession ? `Reply to ${customerName}` : 'No session ID'}
                        className={cn(
                          "flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-lg transition-all",
                          hasSession
                            ? "bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground"
                            : "bg-muted text-muted-foreground/40 cursor-not-allowed"
                        )}
                      >
                        <MessageSquare size={10} />
                        Open Chat
                      </button>
                    )}
                  </div>
                </div>

                {/* Customer info row */}
                <div className="flex items-center gap-3 mt-3 ml-[52px]">
                  {(req.sender_id || req.recipient) && (
                    <span className="text-[11px] text-muted-foreground flex items-center gap-1.5 font-medium">
                      <User size={11} className="opacity-60" />
                      {/* Show resolved name (from cache), fall back to sender_id/recipient raw value */}
                      <span className={cn(
                        (req.sender_id ? localNames[req.sender_id] : null) || (req.recipient ? localNames[req.recipient] : null)
                          ? 'text-foreground/80' : 'text-muted-foreground'
                      )}>
                        {customerName}
                      </span>
                      {/* Also show the raw sender_id as a subtle hint when present */}
                      {req.sender_id && req.sender_id !== customerName && (
                        <span className="text-[9px] text-muted-foreground/50 font-normal ml-0.5">
                          #{req.sender_id}
                        </span>
                      )}
                    </span>
                  )}
                  <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                    <Clock size={11} className="opacity-60" />
                    {formatDistanceToNow(parseISO(req.created_at), { addSuffix: true })}
                  </span>
                </div>
              </div>{/* end card header div[role=button] */}

            </div>
          );
        })}
      </div>
    </div>
  );
};
