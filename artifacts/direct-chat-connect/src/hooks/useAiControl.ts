import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

// ─── Shared direct upsert (no auth required — "Allow all" RLS policy) ─────────
// The ai_control table created by FULL_SETUP_SQL has no user_id column and uses
// "Allow all" RLS so any client (including guest sessions) can write to it.
async function directUpsertAi(session_id: string, ai_enabled: boolean): Promise<boolean> {
  try {
    const { error } = await supabase.from('ai_control').upsert(
      { session_id, ai_enabled, updated_at: new Date().toISOString() },
      { onConflict: 'session_id' }
    );
    return !error;
  } catch {
    return false;
  }
}

/* ── Global Shutdown / Start (all sessions at once) ─────────────── */
export function useGlobalAiControl() {
  const queryClient = useQueryClient();

  const stateQuery = useQuery({
    queryKey: ['ai-control-global'],
    queryFn: async (): Promise<boolean> => {
      const { data } = await supabase
        .from('ai_control')
        .select('ai_enabled')
        .eq('session_id', '__global__')
        .maybeSingle();
      return data?.ai_enabled ?? true;
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const globalOn = stateQuery.data ?? true;

  const toggleMutation = useMutation({
    mutationFn: async (turnOn: boolean) => {
      await directUpsertAi('__global__', turnOn);
    },
    onMutate: async (turnOn) => {
      await queryClient.cancelQueries({ queryKey: ['ai-control-global'] });
      const prev = queryClient.getQueryData<boolean>(['ai-control-global']);
      queryClient.setQueryData(['ai-control-global'], turnOn);
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(['ai-control-global'], ctx.prev);
      toast.error('Could not apply change');
    },
    onSuccess: (_, turnOn) => {
      queryClient.invalidateQueries({ queryKey: ['ai-control'] });
      toast.success(turnOn ? 'All AI active — Start ✓' : 'All AI stopped — Shutdown ✓');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-control-global'] });
    },
  });

  return {
    globalOn,
    toggle: () => toggleMutation.mutate(!globalOn),
    isPending: toggleMutation.isPending || stateQuery.isLoading,
  };
}

export interface AiControlState {
  session_id: string;
  ai_enabled: boolean;
}

export function useAiControl(session_id: string | undefined) {
  const queryClient = useQueryClient();
  const qk = ['ai-control', session_id];

  // ── Initial fetch (staleTime: 0 → always fresh on mount) ──────────────────
  const query = useQuery({
    queryKey: qk,
    queryFn: async (): Promise<boolean> => {
      if (!session_id) return true;
      const { data, error } = await supabase
        .from('ai_control')
        .select('ai_enabled')
        .eq('session_id', session_id)
        .maybeSingle();
      if (error) return true;
      return data?.ai_enabled ?? true;
    },
    enabled: !!session_id,
    staleTime: 0,          // always re-fetch on mount / focus
    refetchInterval: 10_000, // poll every 10 s as safety net
  });

  // ── Realtime subscription: update cache the moment DB row changes ──────────
  // This is what makes AI turn off instantly when HandoffPanel writes to ai_control.
  useEffect(() => {
    if (!session_id) return;
    const channel = supabase
      .channel(`ai-control-${session_id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'ai_control',
          filter: `session_id=eq.${session_id}`,
        },
        (payload) => {
          const row = payload.new as { ai_enabled?: boolean } | undefined;
          if (row?.ai_enabled !== undefined) {
            // Push the new value directly into the cache — no round-trip fetch needed
            queryClient.setQueryData(qk, row.ai_enabled);
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session_id]);

  // ── Toggle mutation (no auth required — "Allow all" RLS) ──────────────────
  const mutation = useMutation({
    mutationFn: async (ai_enabled: boolean) => {
      if (!session_id) throw new Error('No session_id');
      const ok = await directUpsertAi(session_id, ai_enabled);
      if (!ok) throw new Error('Failed to update AI state');
      return ai_enabled;
    },
    onMutate: async (ai_enabled) => {
      await queryClient.cancelQueries({ queryKey: qk });
      const prev = queryClient.getQueryData<boolean>(qk);
      queryClient.setQueryData(qk, ai_enabled);
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(qk, ctx.prev);
      toast.error('Could not save AI status');
    },
    onSuccess: (ai_enabled) => {
      toast.success(ai_enabled ? 'AI enabled' : 'AI disabled');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk });
    },
  });

  const aiEnabled = query.data ?? true;

  return {
    aiEnabled,
    isLoading: query.isLoading || mutation.isPending,
    toggle: () => mutation.mutate(!aiEnabled),
    setEnabled: (val: boolean) => mutation.mutate(val),
    isPending: mutation.isPending,
  };
}

export const AI_CONTROL_SQL = `-- AI Control Table (per-conversation AI toggle)
-- Uses "Allow all" RLS — n8n and guests can write without authentication.
-- Make sure supabase_realtime is enabled so the dashboard updates instantly.
CREATE TABLE IF NOT EXISTS public.ai_control (
  session_id  TEXT        PRIMARY KEY,
  ai_enabled  BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.ai_control ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for ai_control" ON public.ai_control;
CREATE POLICY "Allow all for ai_control" ON public.ai_control
  FOR ALL USING (true) WITH CHECK (true);

-- Enable realtime so the dashboard reflects changes instantly:
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_control;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;`;
