import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { AlertTriangle, CheckCircle, Clock, User, X, Bell, Webhook } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { formatDistanceToNow, parseISO } from 'date-fns';

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

export const HandoffPanel = () => {
  const queryClient = useQueryClient();
  const { data: localHandoffs = [] } = useLocalHandoffs();
  const { data: supabaseHandoffs = [] } = useSupabaseHandoffs();
  const requests = mergeHandoffs(localHandoffs, supabaseHandoffs);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'resolved'>('pending');

  useEffect(() => {
    const channel = supabase
      .channel('handoff-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'handoff_requests' }, () => {
        queryClient.invalidateQueries({ queryKey: ['supabase-handoffs'] });
      })
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
      setSelectedId(null);
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

  return (
    <div className="flex flex-col gap-4">
      {/* Local webhook badge */}
      {localCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-primary/8 border border-primary/20">
          <Webhook size={13} className="text-primary flex-shrink-0" />
          <p className="text-[11px] text-muted-foreground">
            <span className="text-primary font-semibold">{localCount} new</span> handoffs received via webhook
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
      <div className="overflow-y-auto max-h-[55vh] pr-1 space-y-3">
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
            const isExpanded = selectedId === req.id;

            return (
              <button
                key={req.id}
                onClick={() => { setSelectedId(isExpanded ? null : req.id); setNotes(req.notes || ''); }}
                className={cn(
                  "w-full text-left rounded-2xl border transition-all duration-200 overflow-hidden",
                  req.status === 'pending'
                    ? "border-primary/20 bg-gradient-to-r from-primary/[0.03] to-transparent hover:from-primary/[0.06] hover:shadow-md hover:shadow-primary/5"
                    : "border-border bg-muted/20 hover:bg-muted/40",
                  isExpanded && "ring-2 ring-primary/30 shadow-lg shadow-primary/5"
                )}
              >
                <div className="p-4">
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
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="font-semibold text-sm text-foreground leading-tight">{req.reason}</p>
                          {req._source === 'local' && (
                            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded-md flex-shrink-0">
                              <Webhook size={8} /> LIVE
                            </span>
                          )}
                        </div>
                        {req.message && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                            "{req.message}"
                          </p>
                        )}
                      </div>
                    </div>
                    <Badge className={cn(
                      "text-[10px] font-bold tracking-wide px-2.5 py-1 rounded-lg flex-shrink-0",
                      priorityCfg.bg, priorityCfg.text
                    )}>
                      {priorityCfg.label}
                    </Badge>
                  </div>

                  <div className="flex items-center gap-4 mt-3 ml-[52px]">
                    {req.recipient && (
                      <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                        <User size={11} className="opacity-60" /> {req.recipient}
                      </span>
                    )}
                    <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                      <Clock size={11} className="opacity-60" />
                      {formatDistanceToNow(parseISO(req.created_at), { addSuffix: true })}
                    </span>
                  </div>
                </div>

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
              </button>
            );
          })}
      </div>
    </div>
  );
};
