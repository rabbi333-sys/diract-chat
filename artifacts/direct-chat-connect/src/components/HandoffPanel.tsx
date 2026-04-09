import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertTriangle, CheckCircle, Clock, User, X, Bell, Webhook,
  MessageSquare, ChevronDown, ChevronUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { getLocalNames } from '@/hooks/useChatHistory';

interface HandoffRequest {
  id: string;
  session_id: string | null;
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
// Returns true on success so the caller can decide whether to keep the ID in the Set.
async function autoDisableAi(session_id: string): Promise<boolean> {
  if (!session_id) return false;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('ai_control').upsert(
      {
        session_id,
        ai_enabled: false,
        ...(user?.id ? { user_id: user.id } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'session_id' }
    );
    return !error;
  } catch {
    return false; // let caller retry next cycle
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
    refetchInterval: 15000,
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

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'resolved'>('pending');

  // Track which session IDs we've already auto-disabled AI for (avoid repeat calls)
  const aiDisabledRef = useRef<Set<string>>(new Set());

  // ── Auto-disable AI for all pending handoffs on load / change ──────────────
  useEffect(() => {
    for (const req of requests) {
      if (req.status === 'pending' && req.session_id && !aiDisabledRef.current.has(req.session_id)) {
        // Add to Set optimistically to prevent parallel duplicate calls;
        // remove again if the upsert fails so the next render can retry.
        aiDisabledRef.current.add(req.session_id);
        autoDisableAi(req.session_id).then(ok => {
          if (!ok) aiDisabledRef.current.delete(req.session_id!);
        });
      }
    }
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
          // Auto-disable AI for newly inserted pending handoffs
          const newRow = payload.new as HandoffRequest | undefined;
          if (
            newRow?.session_id &&
            newRow.status === 'pending' &&
            !aiDisabledRef.current.has(newRow.session_id)
          ) {
            aiDisabledRef.current.add(newRow.session_id);
            autoDisableAi(newRow.session_id);
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [queryClient]);

  const resolveMutation = useMutation({
    mutationFn: async ({ id, status, source }: { id: string; status: string; source?: string }) => {
      const payload = { status, resolved_at: new Date().toISOString(), notes: notes || null };

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
        .update({ status, resolved_at: new Date().toISOString(), resolved_by: user?.id, notes: notes || null })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['local-handoffs'] });
      queryClient.invalidateQueries({ queryKey: ['supabase-handoffs'] });
      setExpandedId(null);
      setNotes('');
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

  // Resolve customer name from local cache
  const localNames = getLocalNames();
  function resolveName(req: HandoffRequest): string {
    if (!req.recipient) return 'Unknown';
    return localNames[req.recipient] || req.recipient;
  }

  // Navigate to the conversation for this handoff
  function openChat(req: HandoffRequest, e: React.MouseEvent) {
    e.stopPropagation();
    if (!req.session_id) {
      toast.error('No session ID on this handoff — cannot open conversation');
      return;
    }
    const params = req.recipient ? `?recipient=${encodeURIComponent(req.recipient)}` : '';
    navigate(`/conversation/${req.session_id}${params}`);
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
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-3">
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
          const isExpanded = expandedId === req.id;
          const customerName = resolveName(req);
          const hasSession = !!req.session_id;

          return (
            <div
              key={req.id}
              className={cn(
                "w-full text-left rounded-2xl border transition-all duration-200 overflow-hidden",
                req.status === 'pending'
                  ? "border-primary/20 bg-gradient-to-r from-primary/[0.03] to-transparent"
                  : "border-border bg-muted/20",
                isExpanded && "ring-2 ring-primary/30 shadow-lg shadow-primary/5"
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
                  {req.recipient && (
                    <span className="text-[11px] text-muted-foreground flex items-center gap-1.5 font-medium">
                      <User size={11} className="opacity-60" />
                      {/* Show resolved name, fall back to raw ID */}
                      <span className={cn(
                        localNames[req.recipient] ? 'text-foreground/80' : 'text-muted-foreground'
                      )}>
                        {customerName}
                      </span>
                    </span>
                  )}
                  <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                    <Clock size={11} className="opacity-60" />
                    {formatDistanceToNow(parseISO(req.created_at), { addSuffix: true })}
                  </span>
                </div>
              </div>{/* end card header div[role=button] */}

              {/* ── Expand toggle for notes/resolve (stopPropagation) ──── */}
              <div
                className="px-4 pb-1 flex items-center justify-between border-t border-border/20"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground py-2 transition-colors"
                  onClick={() => { setExpandedId(isExpanded ? null : req.id); setNotes(req.notes || ''); }}
                >
                  {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  {isExpanded ? 'Hide' : 'Notes & Actions'}
                </button>
                {req.status !== 'pending' && req.notes && (
                  <span className="text-[10px] text-muted-foreground/60 truncate max-w-[160px]">
                    {req.notes}
                  </span>
                )}
              </div>

              {/* ── Expanded notes/resolve section ──────────────────────── */}
              {isExpanded && (
                <div className="px-4 pb-4 pt-0 space-y-3 animate-in slide-in-from-top-2 duration-200" onClick={e => e.stopPropagation()}>
                  <div className="border-t border-border/50 pt-3 ml-[52px]">
                    {req.session_id && (
                      <p className="text-xs text-muted-foreground mb-2">
                        <span className="font-semibold text-foreground/80">Session:</span> {req.session_id}
                      </p>
                    )}
                    {req.agent_data && Object.keys(req.agent_data).length > 0 && (
                      <pre className="text-[10px] bg-background p-3 rounded-xl border border-border overflow-x-auto mb-3">
                        {JSON.stringify(req.agent_data, null, 2)}
                      </pre>
                    )}
                    {req.status === 'pending' && (
                      <>
                        <Textarea
                          placeholder="Add notes before resolving..."
                          value={notes}
                          onChange={e => setNotes(e.target.value)}
                          className="text-xs min-h-[60px] rounded-xl border-border/50 focus:border-primary/50 resize-none"
                        />
                        <div className="flex gap-2 mt-2">
                          <Button
                            size="sm"
                            className="flex-1 text-xs rounded-xl h-9 shadow-sm shadow-primary/10"
                            onClick={() => resolveMutation.mutate({ id: req.id, status: 'resolved', source: req._source })}
                            disabled={resolveMutation.isPending}
                          >
                            <CheckCircle size={14} className="mr-1.5" /> Resolve
                          </Button>
                          <Button
                            size="sm" variant="outline" className="text-xs rounded-xl h-9"
                            onClick={() => resolveMutation.mutate({ id: req.id, status: 'dismissed', source: req._source })}
                            disabled={resolveMutation.isPending}
                          >
                            <X size={14} className="mr-1.5" /> Dismiss
                          </Button>
                        </div>
                      </>
                    )}
                    {req.status !== 'pending' && req.notes && (
                      <p className="text-xs text-muted-foreground">
                        <span className="font-semibold">Notes:</span> {req.notes}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
