import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { format, subDays, subMonths, startOfWeek, endOfWeek } from 'date-fns';
import {
  getStoredConnection,
  queryExternalSupabase,
  buildSessionsFromMessages,
  normalizeRow,
  NormalizedMessage,
} from '@/lib/externalDb';

export interface ChatMessage {
  id: string | number;
  session_id: string;
  sender: 'User' | 'AI' | 'Agent';
  message_text: string;
  timestamp: string;
  recipient?: string;
  replyTo?: ChatMessage;
  _sending?: boolean; // true while API call in-flight, false = delivered
}

export interface SessionInfo {
  session_id: string;
  recipient: string;
  last_message_at: string;
  message_count: number;
  is_active: boolean;
}

export interface RecipientName {
  recipient_id: string;
  name: string;
}

export interface AnalyticsData {
  total_sessions: number;
  total_messages: number;
  human_messages: number;
  ai_messages: number;
}

export interface ChartData {
  label: string;
  conversations: number;
  messages: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function computeAnalytics(msgs: NormalizedMessage[]): AnalyticsData {
  const sessions = new Set(msgs.map((m) => m.session_id));
  return {
    total_sessions: sessions.size,
    total_messages: msgs.length,
    human_messages: msgs.filter((m) => m.sender === 'User').length,
    ai_messages: msgs.filter((m) => m.sender === 'AI').length,
  };
}

function computeChartData(msgs: NormalizedMessage[], timeRange: 'daily' | 'weekly' | 'monthly'): ChartData[] {
  const now = new Date();

  if (timeRange === 'daily') {
    return Array.from({ length: 7 }, (_, i) => {
      const d = subDays(now, 6 - i);
      const dateStr = format(d, 'yyyy-MM-dd');
      const dayMsgs = msgs.filter((m) => (m.timestamp || '').startsWith(dateStr));
      const sessions = new Set(dayMsgs.map((m) => m.session_id));
      return { label: DAY_NAMES[d.getDay()], conversations: sessions.size, messages: dayMsgs.length };
    });
  }

  if (timeRange === 'weekly') {
    return Array.from({ length: 4 }, (_, i) => {
      const weekRef = subDays(now, (3 - i) * 7);
      const wStart = startOfWeek(weekRef);
      const wEnd = endOfWeek(weekRef);
      const wMsgs = msgs.filter((m) => {
        try { const d = new Date(m.timestamp); return d >= wStart && d <= wEnd; } catch { return false; }
      });
      const sessions = new Set(wMsgs.map((m) => m.session_id));
      return { label: `Week ${i + 1}`, conversations: sessions.size, messages: wMsgs.length };
    });
  }

  // monthly
  return Array.from({ length: 6 }, (_, i) => {
    const ref = subMonths(now, 5 - i);
    const yr = ref.getFullYear();
    const mo = ref.getMonth();
    const mMsgs = msgs.filter((m) => {
      try { const d = new Date(m.timestamp); return d.getFullYear() === yr && d.getMonth() === mo; } catch { return false; }
    });
    const sessions = new Set(mMsgs.map((m) => m.session_id));
    return { label: MONTH_NAMES[mo], conversations: sessions.size, messages: mMsgs.length };
  });
}

// ─── Fetch all messages from external DB (used by analytics + chart) ──────────
async function fetchAllMessages(): Promise<NormalizedMessage[]> {
  const conn = getStoredConnection();

  if (conn && conn.db_type === 'supabase' && conn.supabase_url && conn.service_role_key) {
    return queryExternalSupabase(conn, 'sessions'); // fetches all rows
  }

  // Fallback: edge function
  try {
    const { data, error } = await supabase.functions.invoke('get-chat-history', {
      method: 'POST',
      body: { type: 'sessions', connection: conn ? { ...conn, is_active: true } : null },
    });
    if (error || !data?.sessions) return [];
    // Edge function returns sessions not raw messages — can't compute chart data from it
    return [];
  } catch {
    return [];
  }
}

// ─── useAnalytics ─────────────────────────────────────────────────────────────
export const useAnalytics = () => {
  return useQuery({
    queryKey: ['analytics'],
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<AnalyticsData> => {
      const conn = getStoredConnection();

      // Direct Supabase connection — compute from raw rows
      if (conn && conn.db_type === 'supabase' && conn.supabase_url && conn.service_role_key) {
        try {
          const msgs = await queryExternalSupabase(conn, 'sessions');
          return computeAnalytics(msgs);
        } catch {
          return { total_sessions: 0, total_messages: 0, human_messages: 0, ai_messages: 0 };
        }
      }

      // Edge function fallback for non-Supabase
      try {
        const { data, error } = await supabase.functions.invoke('get-chat-history', {
          method: 'POST',
          body: { type: 'analytics', connection: conn ? { ...conn, is_active: true } : null },
        });
        if (error) throw error;
        return data as AnalyticsData;
      } catch {
        return { total_sessions: 0, total_messages: 0, human_messages: 0, ai_messages: 0 };
      }
    },
  });
};

// ─── useChartData ─────────────────────────────────────────────────────────────
export const useChartData = (timeRange: 'daily' | 'weekly' | 'monthly') => {
  return useQuery({
    queryKey: ['chart-data', timeRange],
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<ChartData[]> => {
      const conn = getStoredConnection();

      if (conn && conn.db_type === 'supabase' && conn.supabase_url && conn.service_role_key) {
        try {
          const msgs = await queryExternalSupabase(conn, 'sessions');
          return computeChartData(msgs, timeRange);
        } catch {
          return computeChartData([], timeRange);
        }
      }

      // Edge function fallback
      try {
        const { data, error } = await supabase.functions.invoke('get-chat-history', {
          method: 'POST',
          body: { type: 'chart_data', time_range: timeRange, connection: conn ? { ...conn, is_active: true } : null },
        });
        if (error) throw error;
        return data as ChartData[];
      } catch {
        return computeChartData([], timeRange);
      }
    },
  });
};

// ─── Standalone fetch (reused by useChatHistory + prefetch) ───────────────────
export async function fetchMessages(sessionId: string): Promise<ChatMessage[]> {
  const conn = getStoredConnection();
  if (conn && conn.db_type === 'supabase' && conn.supabase_url && conn.service_role_key) {
    const msgs = await queryExternalSupabase(conn, 'messages', sessionId);
    return msgs.filter((m) => m.session_id === sessionId) as ChatMessage[];
  }
  const { data, error } = await supabase.functions.invoke('get-chat-history', {
    method: 'POST',
    body: { type: 'messages', session_id: sessionId, connection: conn ? { ...conn, is_active: true } : null },
  });
  if (error) throw new Error(error.message);
  if (data?.error === 'TABLE_NOT_FOUND') throw new Error('TABLE_NOT_FOUND');
  return (data?.messages ?? []) as ChatMessage[];
}

// ─── useChatHistory ───────────────────────────────────────────────────────────
export const useChatHistory = (sessionId?: string) => {
  return useQuery({
    queryKey: ['chat-history', sessionId],
    enabled: !!sessionId,
    retry: 1,
    staleTime: 60_000,       // cache for 60s — no refetch on back navigation
    gcTime: 5 * 60_000,      // keep in memory for 5 min
    queryFn: () => fetchMessages(sessionId!),
  });
};

// ─── useSessions ──────────────────────────────────────────────────────────────
export const useSessions = (filterDate?: Date | null) => {
  return useQuery({
    queryKey: ['sessions', filterDate ? format(filterDate, 'yyyy-MM-dd') : 'all'],
    staleTime: 30_000,
    refetchInterval: 60_000,  // auto-refresh every minute
    retry: 1,
    queryFn: async () => {
      const conn = getStoredConnection();

      if (conn && conn.db_type === 'supabase' && conn.supabase_url && conn.service_role_key) {
        try {
          const msgs = await queryExternalSupabase(conn, 'sessions');
          const filtered = filterDate
            ? msgs.filter((m) => {
                try { return format(new Date(m.timestamp), 'yyyy-MM-dd') === format(filterDate, 'yyyy-MM-dd'); }
                catch { return true; }
              })
            : msgs;
          return buildSessionsFromMessages(filtered) as SessionInfo[];
        } catch (e: unknown) {
          if (e instanceof Error && e.message === 'TABLE_NOT_FOUND') return [] as SessionInfo[];
          throw e;
        }
      }

      try {
        const body: Record<string, unknown> = {
          type: 'sessions',
          connection: conn ? { ...conn, is_active: true } : null,
        };
        if (filterDate) body.filter_date = format(filterDate, 'yyyy-MM-dd');
        const { data, error } = await supabase.functions.invoke('get-chat-history', {
          method: 'POST',
          body,
        });
        if (error) throw new Error(error.message);
        if (data?.error === 'TABLE_NOT_FOUND') return [] as SessionInfo[];
        return (data?.sessions ?? []) as SessionInfo[];
      } catch {
        return [] as SessionInfo[];
      }
    },
  });
};

// ─── localStorage name cache (works even without recipient_names table) ────────
const LOCAL_NAMES_KEY = 'chat_monitor_recipient_names';

export function getLocalNames(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LOCAL_NAMES_KEY) || '{}'); }
  catch { return {}; }
}

export function saveLocalName(id: string, name: string) {
  try {
    const cur = getLocalNames();
    cur[id] = name;
    localStorage.setItem(LOCAL_NAMES_KEY, JSON.stringify(cur));
  } catch { /* ignore */ }
}

// ─── useRecipientNames ────────────────────────────────────────────────────────
export const useRecipientNames = () => {
  return useQuery({
    queryKey: ['recipient-names'],
    staleTime: 15_000,
    gcTime: 30 * 60_000,
    queryFn: async () => {
      // Always start with localStorage (works without Supabase table)
      const map: Record<string, string> = getLocalNames();
      // Try to merge with Supabase table (optional — ignore if table missing)
      try {
        const { data } = await supabase
          .from('recipient_names')
          .select('recipient_id, name');
        data?.forEach((item: RecipientName) => {
          map[item.recipient_id] = item.name;
          saveLocalName(item.recipient_id, item.name);
        });
      } catch { /* table may not exist — local cache is enough */ }
      return map;
    },
  });
};

// TTL-based cache: maps recipient ID → timestamp of last attempt
// Reduced to 5 min so failed attempts retry quickly on the same session
const _autoResolveAttemptedAt = new Map<string, number>();
const RETRY_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface PlatformConnLike {
  platform: string;
  is_active: boolean;
  access_token: string;
}

/**
 * Silently fetches real names from Meta Graph API for any recipients
 * whose IDs appear numeric (from Facebook/Instagram) and aren't already in `knownNames`.
 * On success, upserts to `recipient_names` in the local Supabase project.
 * Failed IDs are retried after RETRY_TTL_MS so stale/expired tokens can be recovered.
 */
export const useAutoResolveNames = (
  recipients: string[],
  knownNames: Record<string, string> | undefined,
  platformConns: PlatformConnLike[]
) => {
  const queryClient = useQueryClient();

  const recipientsKey = recipients.join(',');
  const namesKey = Object.keys(knownNames ?? {}).join(',');
  const tokensKey = platformConns
    .filter(c => c.is_active && (c.platform === 'facebook' || c.platform === 'instagram') && c.access_token)
    .map(c => c.access_token)
    .join(',');

  useEffect(() => {
    const tokens = tokensKey.split(',').filter(Boolean);
    if (tokens.length === 0) return;

    const now = Date.now();
    const known = knownNames ?? {};
    const unresolved = recipients.filter(r => {
      if (!r || !/^\d+$/.test(r)) return false;
      if (known[r]) return false;
      const lastAttempt = _autoResolveAttemptedAt.get(r);
      return lastAttempt === undefined || now - lastAttempt > RETRY_TTL_MS;
    });
    if (unresolved.length === 0) return;

    // Stamp all as attempted immediately so concurrent renders don't duplicate
    unresolved.forEach(r => _autoResolveAttemptedAt.set(r, now));

    Promise.all(
      unresolved.map(async (recipientId): Promise<boolean> => {
        for (const token of tokens) {
          // ── Method 1: conversations endpoint (reliable with Page tokens) ──
          // This is the same approach used in n8n:
          // GET /me/conversations?user_id={id}&fields=participants{name,email,id}
          try {
            const convRes = await fetch(
              `https://graph.facebook.com/v19.0/me/conversations?user_id=${recipientId}&fields=participants%7Bname%2Cemail%2Cid%7D&access_token=${token}`
            );
            const convData = await convRes.json();
            // Name is at data[0].participants.data[0].name (first participant who is the user)
            const participants: Array<{ id: string; name: string }> =
              convData?.data?.[0]?.participants?.data ?? [];
            // The page itself is also a participant — pick the one whose id matches the sender
            const senderParticipant =
              participants.find((p) => p.id === recipientId) ||
              participants.find((p) => p.id !== recipientId);
            const resolvedName = senderParticipant?.name;
            if (resolvedName && !convData.error) {
              // Save to localStorage immediately (no Supabase table required)
              saveLocalName(recipientId, resolvedName);
              // Also try Supabase (optional — ignore if table missing)
              try {
                await supabase.from('recipient_names').upsert(
                  { recipient_id: recipientId, name: resolvedName, updated_at: new Date().toISOString() },
                  { onConflict: 'recipient_id' }
                );
              } catch { /* ignore */ }
              return true;
            }
          } catch {
            // fall through to method 2
          }

          // ── Method 2: direct profile (fallback for WhatsApp/Instagram) ──
          try {
            const res = await fetch(
              `https://graph.facebook.com/v19.0/${recipientId}?fields=name&access_token=${token}`
            );
            const data = await res.json();
            if (data.name && !data.error) {
              saveLocalName(recipientId, data.name);
              try {
                await supabase.from('recipient_names').upsert(
                  { recipient_id: recipientId, name: data.name, updated_at: new Date().toISOString() },
                  { onConflict: 'recipient_id' }
                );
              } catch { /* ignore */ }
              return true;
            }
          } catch {
            // try next token
          }
        }
        return false;
      })
    ).then(results => {
      if (results.some(Boolean)) {
        queryClient.invalidateQueries({ queryKey: ['recipient-names'] });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipientsKey, namesKey, tokensKey]);
};

// ─── useUpdateRecipientName ───────────────────────────────────────────────────
export const useUpdateRecipientName = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ recipientId, name }: { recipientId: string; name: string }) => {
      // Always save to localStorage first
      saveLocalName(recipientId, name);
      // Also try Supabase (optional)
      try {
        await supabase.from('recipient_names').upsert(
          { recipient_id: recipientId, name, updated_at: new Date().toISOString() },
          { onConflict: 'recipient_id' }
        );
      } catch { /* ignore if table doesn't exist */ }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipient-names'] });
    },
  });
};

// ─── fetchNameFromMeta (standalone — used by manual refresh button) ───────────
export async function fetchNameFromMeta(
  recipientId: string,
  tokens: string[]
): Promise<string | null> {
  for (const token of tokens) {
    // Method 1: conversations endpoint (Facebook Page tokens)
    try {
      const res = await fetch(
        `https://graph.facebook.com/v19.0/me/conversations?user_id=${recipientId}&fields=participants%7Bname%2Cemail%2Cid%7D&access_token=${token}`
      );
      const convData = await res.json();
      const participants: Array<{ id: string; name: string }> =
        convData?.data?.[0]?.participants?.data ?? [];
      const match =
        participants.find((p) => p.id === recipientId) ||
        participants.find((p) => p.id !== recipientId);
      if (match?.name && !convData.error) {
        saveLocalName(recipientId, match.name);
        return match.name;
      }
    } catch { /* fall through */ }

    // Method 2: direct profile
    try {
      const res = await fetch(
        `https://graph.facebook.com/v19.0/${recipientId}?fields=name&access_token=${token}`
      );
      const data = await res.json();
      if (data.name && !data.error) {
        saveLocalName(recipientId, data.name);
        return data.name;
      }
    } catch { /* try next token */ }
  }
  return null;
}

// Re-export for components that need it
export { normalizeRow };
