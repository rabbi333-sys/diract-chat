import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

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
    staleTime: 15_000,
  });

  const globalOn = stateQuery.data ?? true;

  const toggleMutation = useMutation({
    mutationFn: async (turnOn: boolean) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('ai_control')
        .update({ ai_enabled: turnOn, updated_at: new Date().toISOString() })
        .eq('user_id', user.id);
      if (error) throw error;
      await supabase.from('ai_control').upsert(
        { session_id: '__global__', ai_enabled: turnOn, user_id: user.id, updated_at: new Date().toISOString() },
        { onConflict: 'session_id' }
      );
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
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: async (ai_enabled: boolean) => {
      if (!session_id) throw new Error('No session_id');
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('ai_control')
        .upsert(
          { session_id, ai_enabled, user_id: user.id, updated_at: new Date().toISOString() },
          { onConflict: 'session_id' }
        );
      if (error) throw error;
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
    isPending: mutation.isPending,
  };
}

export const AI_CONTROL_SQL = `-- AI Control Table (per-conversation AI toggle)
CREATE TABLE IF NOT EXISTS public.ai_control (
  session_id  TEXT        PRIMARY KEY,
  ai_enabled  BOOLEAN     NOT NULL DEFAULT TRUE,
  user_id     UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.ai_control ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_control_own" ON public.ai_control;
CREATE POLICY "ai_control_own" ON public.ai_control
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);`;
