import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertOctagon, CheckCircle, Clock, XCircle, AlertTriangle, RotateCcw, Webhook } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { formatDistanceToNow, parseISO } from 'date-fns';

interface FailedAutomation {
  id: string;
  workflow_name: string | null;
  error_message: string;
  error_details: Record<string, unknown>;
  source: string;
  session_id: string | null;
  recipient: string | null;
  severity: string;
  created_at: string;
  resolved: boolean;
  resolved_at: string | null;
  _source?: 'local' | 'supabase';
}

const useLocalFailures = () =>
  useQuery({
    queryKey: ['local-failures'],
    retry: false,
    refetchInterval: 5000,
    queryFn: async (): Promise<FailedAutomation[]> => {
      try {
        const res = await fetch('/api/local/failures');
        if (!res.ok) return [];
        const data = await res.json();
        return (Array.isArray(data) ? data : []).map((d: FailedAutomation) => ({ ...d, _source: 'local' as const }));
      } catch { return []; }
    },
  });

const useSupabaseFailures = () =>
  useQuery({
    queryKey: ['supabase-failures'],
    retry: false,
    refetchInterval: 15000,
    queryFn: async (): Promise<FailedAutomation[]> => {
      try {
        const { data, error } = await supabase
          .from('failed_automations' as any)
          .select('*')
          .order('created_at', { ascending: false });
        if (error) return [];
        return ((data ?? []) as unknown as FailedAutomation[]).map(d => ({ ...d, _source: 'supabase' as const }));
      } catch { return []; }
    },
  });

function mergeFailures(local: FailedAutomation[], remote: FailedAutomation[]): FailedAutomation[] {
  const seen = new Set<string>();
  const result: FailedAutomation[] = [];
  for (const item of [...local, ...remote]) {
    if (!seen.has(item.id)) { seen.add(item.id); result.push(item); }
  }
  return result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export const FailedPanel = () => {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'active' | 'resolved' | 'all'>('active');

  const { data: localFailures = [] } = useLocalFailures();
  const { data: supabaseFailures = [] } = useSupabaseFailures();
  const failures = mergeFailures(localFailures, supabaseFailures);

  useEffect(() => {
    const channel = supabase
      .channel('failed-automations-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'failed_automations' }, () =>
        queryClient.invalidateQueries({ queryKey: ['supabase-failures'] })
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [queryClient]);

  const resolveMutation = useMutation({
    mutationFn: async ({ id, source }: { id: string; source?: string }) => {
      const payload = { resolved: true, resolved_at: new Date().toISOString() };
      if (source === 'local') {
        const res = await fetch(`/api/local/failures/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('Failed to update local failure');
        return;
      }
      const { error } = await supabase
        .from('failed_automations' as any)
        .update(payload)
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['local-failures'] });
      queryClient.invalidateQueries({ queryKey: ['supabase-failures'] });
      setSelectedId(null);
      toast.success('Marked as resolved!');
    },
  });

  const filtered = failures.filter(f => {
    if (filter === 'active')   return !f.resolved;
    if (filter === 'resolved') return f.resolved;
    return true;
  });

  const activeCount = failures.filter(f => !f.resolved).length;
  const localActiveCount = localFailures.filter(f => !f.resolved).length;

  const getSeverityConfig = (severity: string) => {
    switch (severity) {
      case 'critical': return { icon: AlertOctagon, bg: 'bg-destructive/15', text: 'text-destructive', iconColor: 'text-destructive', label: 'CRITICAL' };
      case 'warning':  return { icon: AlertTriangle, bg: 'bg-amber-500/15', text: 'text-amber-600 dark:text-amber-400', iconColor: 'text-amber-500', label: 'WARNING' };
      default:         return { icon: XCircle, bg: 'bg-destructive/10', text: 'text-destructive', iconColor: 'text-destructive/80', label: 'ERROR' };
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {localActiveCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-destructive/8 border border-destructive/20">
          <Webhook size={13} className="text-destructive flex-shrink-0" />
          <p className="text-[11px] text-muted-foreground">
            <span className="text-destructive font-semibold">{localActiveCount} active failure(s)</span> received via webhook
          </p>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex bg-muted/50 rounded-2xl p-1 border border-border/50">
        {(['active', 'resolved', 'all'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            className={cn(
              "flex-1 text-xs font-semibold py-2.5 rounded-xl transition-all capitalize",
              filter === tab
                ? "bg-destructive text-destructive-foreground shadow-md"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab === 'active' ? 'Active' : tab === 'resolved' ? 'Resolved' : 'All'}
            {tab === 'active' && activeCount > 0 && (
              <span className="ml-1 inline-flex items-center justify-center h-5 w-5 rounded-full bg-destructive-foreground/20 text-[10px]">
                {activeCount}
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
                <CheckCircle size={28} className="opacity-40" />
              </div>
              <p className="text-sm font-medium">No {filter === 'active' ? 'active ' : ''} failures</p>
              <p className="text-xs text-muted-foreground/70 mt-1">All clear! 🎉</p>
            </div>
          )}

          {filtered.map(fail => {
            const severityCfg = getSeverityConfig(fail.severity);
            const SeverityIcon = severityCfg.icon;
            const isExpanded = selectedId === fail.id;

            return (
              <button
                key={fail.id}
                onClick={() => setSelectedId(isExpanded ? null : fail.id)}
                className={cn(
                  "w-full text-left rounded-2xl border transition-all duration-200 overflow-hidden",
                  !fail.resolved
                    ? "border-destructive/20 bg-gradient-to-r from-destructive/[0.03] to-transparent hover:from-destructive/[0.06] hover:shadow-md hover:shadow-destructive/5"
                    : "border-border bg-muted/20 hover:bg-muted/40",
                  isExpanded && "ring-2 ring-destructive/30 shadow-lg shadow-destructive/5"
                )}
              >
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className={cn(
                        "h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5",
                        fail.resolved ? "bg-muted" : severityCfg.bg
                      )}>
                        {fail.resolved
                          ? <CheckCircle size={18} className="text-muted-foreground" />
                          : <SeverityIcon size={18} className={severityCfg.iconColor} />}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          {fail.workflow_name && (
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                              {fail.workflow_name}
                            </span>
                          )}
                          {fail._source === 'local' && (
                            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold text-destructive bg-destructive/10 px-1.5 py-0.5 rounded-md flex-shrink-0">
                              <Webhook size={8} /> LIVE
                            </span>
                          )}
                        </div>
                        <p className="font-medium text-sm text-foreground leading-tight mt-0.5">{fail.error_message}</p>
                      </div>
                    </div>
                    <Badge className={cn(
                      "text-[10px] font-bold tracking-wide px-2.5 py-1 rounded-lg flex-shrink-0",
                      fail.resolved ? "bg-muted text-muted-foreground" : severityCfg.bg + ' ' + severityCfg.text
                    )}>
                      {fail.resolved ? 'RESOLVED' : severityCfg.label}
                    </Badge>
                  </div>

                  <div className="flex items-center gap-4 mt-3 ml-[52px]">
                    {fail.recipient && (
                      <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">👤 {fail.recipient}</span>
                    )}
                    <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                      <Clock size={11} className="opacity-60" />
                      {formatDistanceToNow(parseISO(fail.created_at), { addSuffix: true })}
                    </span>
                    {fail.source && (
                      <span className="text-[11px] text-muted-foreground">
                        via <span className="font-medium">{fail.source}</span>
                      </span>
                    )}
                  </div>
                </div>

                {isExpanded && (
                  <div className="px-4 pb-4 pt-0 animate-in slide-in-from-top-2 duration-200" onClick={e => e.stopPropagation()}>
                    <div className="border-t border-border/50 pt-3 ml-[52px] space-y-3">
                      {fail.session_id && (
                        <p className="text-xs text-muted-foreground">
                          <span className="font-semibold text-foreground/80">Session:</span> {fail.session_id}
                        </p>
                      )}
                      {fail.error_details && Object.keys(fail.error_details).length > 0 && (
                        <div>
                          <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">Error Details:</p>
                          <pre className="text-[10px] bg-background p-3 rounded-xl border border-border overflow-x-auto leading-relaxed">
                            {JSON.stringify(fail.error_details, null, 2)}
                          </pre>
                        </div>
                      )}
                      {!fail.resolved && (
                        <Button
                          size="sm" variant="outline" className="text-xs rounded-xl h-9"
                          onClick={() => resolveMutation.mutate({ id: fail.id, source: fail._source })}
                          disabled={resolveMutation.isPending}
                        >
                          <RotateCcw size={14} className="mr-1.5" /> Mark Resolved
                        </Button>
                      )}
                      {fail.resolved && fail.resolved_at && (
                        <p className="text-[11px] text-muted-foreground">
                          Resolved {formatDistanceToNow(parseISO(fail.resolved_at), { addSuffix: true })}
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
