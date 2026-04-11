import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { format, subDays, subMonths, startOfWeek, endOfWeek } from 'date-fns';
import {
  getStoredConnection,
  queryExternalSupabase,
  buildSessionsFromMessages,
  normalizeRow,
  NormalizedMessage,
} from '@/lib/externalDb';
import { getActiveConnection, onDbChange } from '@/lib/db-config';
import type { MainDbConnection } from '@/lib/db-config';

// Returns a key string that changes every time the active DB connection changes.
// Including this in a query key causes React Query to refetch automatically.
function getConnectionKey(): string {
  const conn = getActiveConnection();
  if (!conn) return 'none';
  return `${conn.id}:${conn.url || conn.host || conn.connectionString || ''}`;
}

export function useDbConnectionKey(): string {
  const [key, setKey] = useState(getConnectionKey);
  useEffect(() => onDbChange(() => setKey(getConnectionKey())), []);
  return key;
}

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

const FALLBACK_TS = '2000-01-01T00:00:00.000Z';

function computeChartData(msgs: NormalizedMessage[], timeRange: 'daily' | 'weekly' | 'monthly'): ChartData[] {
  const now = new Date();

  // If no messages have real timestamps (all fallback), show totals in the most recent bucket
  const hasRealTimestamps = msgs.some((m) => m.timestamp !== FALLBACK_TS);
  if (!hasRealTimestamps && msgs.length > 0) {
    const totalSessions = new Set(msgs.map((m) => m.session_id)).size;
    const totalMessages = msgs.length;
    if (timeRange === 'daily') {
      return Array.from({ length: 7 }, (_, i) => {
        const d = subDays(now, 6 - i);
        return { label: DAY_NAMES[d.getDay()], conversations: i === 6 ? totalSessions : 0, messages: i === 6 ? totalMessages : 0 };
      });
    }
    if (timeRange === 'weekly') {
      return Array.from({ length: 4 }, (_, i) => ({
        label: `Week ${i + 1}`,
        conversations: i === 3 ? totalSessions : 0,
        messages: i === 3 ? totalMessages : 0,
      }));
    }
    return Array.from({ length: 6 }, (_, i) => {
      const ref = subMonths(now, 5 - i);
      return { label: MONTH_NAMES[ref.getMonth()], conversations: i === 5 ? totalSessions : 0, messages: i === 5 ? totalMessages : 0 };
    });
  }

  if (timeRange === 'daily') {
    return Array.from({ length: 7 }, (_, i) => {
      const d = subDays(now, 6 - i);
      const dateStr = format(d, 'yyyy-MM-dd');
      const dayMsgs = msgs.filter((m) => m.timestamp !== FALLBACK_TS && (m.timestamp || '').startsWith(dateStr));
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
        if (m.timestamp === FALLBACK_TS) return false;
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
      if (m.timestamp === FALLBACK_TS) return false;
      try { const d = new Date(m.timestamp); return d.getFullYear() === yr && d.getMonth() === mo; } catch { return false; }
    });
    const sessions = new Set(mMsgs.map((m) => m.session_id));
    return { label: MONTH_NAMES[mo], conversations: sessions.size, messages: mMsgs.length };
  });
}

// ─── API Server helpers (for non-Supabase databases) ─────────────────────────

type SessionsCreds = {
  dbType: string;
  host?: string;
  port?: string;
  dbUsername?: string;
  dbPassword?: string;
  dbName?: string;
  connectionString?: string;
  supabaseUrl?: string;
  tableName?: string;
};

function buildSessionsCreds(conn: MainDbConnection): SessionsCreds {
  return {
    dbType: conn.dbType,
    host: conn.host,
    port: conn.port,
    dbUsername: conn.dbUsername,
    dbPassword: conn.dbPassword,
    dbName: conn.dbName,
    connectionString: conn.connectionString,
  };
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const errMsg = (data.error as string) || `Request failed: ${res.status}`;
    if (errMsg === 'TABLE_NOT_FOUND') throw new Error('TABLE_NOT_FOUND');
    throw new Error(errMsg);
  }
  return data as T;
}

// ─── Active connection reader (reads new db-config format first, falls back to legacy) ────

function getActiveConn(): { legacy: ReturnType<typeof getStoredConnection>; main: MainDbConnection | null } {
  return {
    legacy: getStoredConnection(),
    main: getActiveConnection(),
  };
}

// ─── Determine if we should use the API server for sessions ───────────────────

function shouldUseApiServer(conn: MainDbConnection | null): boolean {
  if (!conn) return false;
  if (conn.dbType === 'supabase') return false; // Supabase handled browser-side
  return ['postgresql', 'mysql', 'mongodb', 'redis'].includes(conn.dbType);
}

// ─── Fetch all messages from external DB (used by analytics + chart) ──────────
async function fetchAllMessages(): Promise<NormalizedMessage[]> {
  const { legacy, main } = getActiveConn();

  // 1. New connection system — non-Supabase: use API server
  if (main && shouldUseApiServer(main)) {
    const creds = buildSessionsCreds(main);
    const { analytics } = await apiPost<{ analytics: { total_sessions: number; total_messages: number; human_messages: number; ai_messages: number } }>('/api/sessions/analytics', { creds });
    // analytics endpoint doesn't return raw messages — return empty (used only for chart/analytics, we handle those separately)
    void analytics;
    return [];
  }

  // 2. Supabase via new connection (has serviceRoleKey)
  if (main && main.dbType === 'supabase' && main.url && main.serviceRoleKey) {
    const fakeConn = { db_type: 'supabase' as const, supabase_url: main.url, service_role_key: main.serviceRoleKey, host: '', port: '', username: '', password: '', database: '', connection_string: '', table_name: '' };
    return queryExternalSupabase(fakeConn, 'sessions');
  }

  // 3. Legacy stored connection — Supabase
  if (legacy && legacy.db_type === 'supabase' && legacy.supabase_url && legacy.service_role_key) {
    return queryExternalSupabase(legacy, 'sessions');
  }

  // 4. Edge function fallback
  try {
    const { data, error } = await supabase.functions.invoke('get-chat-history', {
      method: 'POST',
      body: { type: 'sessions', connection: legacy ? { ...legacy, is_active: true } : null },
    });
    if (error || !data?.sessions) return [];
    return [];
  } catch {
    return [];
  }
}

// ─── useAnalytics ─────────────────────────────────────────────────────────────
export const useAnalytics = () => {
  const dbKey = useDbConnectionKey();
  return useQuery({
    queryKey: ['analytics', dbKey],
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<AnalyticsData> => {
      const { legacy, main } = getActiveConn();

      // Non-Supabase via API server
      if (main && shouldUseApiServer(main)) {
        try {
          const creds = buildSessionsCreds(main);
          const data = await apiPost<AnalyticsData>('/api/sessions/analytics', { creds });
          return data;
        } catch {
          return { total_sessions: 0, total_messages: 0, human_messages: 0, ai_messages: 0 };
        }
      }

      // Supabase via new connection
      if (main && main.dbType === 'supabase' && main.url && main.serviceRoleKey) {
        try {
          const fakeConn = { db_type: 'supabase' as const, supabase_url: main.url, service_role_key: main.serviceRoleKey, host: '', port: '', username: '', password: '', database: '', connection_string: '', table_name: '' };
          const msgs = await queryExternalSupabase(fakeConn, 'sessions');
          return computeAnalytics(msgs);
        } catch {
          return { total_sessions: 0, total_messages: 0, human_messages: 0, ai_messages: 0 };
        }
      }

      // Legacy Supabase connection
      if (legacy && legacy.db_type === 'supabase' && legacy.supabase_url && legacy.service_role_key) {
        try {
          const msgs = await queryExternalSupabase(legacy, 'sessions');
          return computeAnalytics(msgs);
        } catch {
          return { total_sessions: 0, total_messages: 0, human_messages: 0, ai_messages: 0 };
        }
      }

      // Edge function fallback
      try {
        const { data, error } = await supabase.functions.invoke('get-chat-history', {
          method: 'POST',
          body: { type: 'analytics', connection: legacy ? { ...legacy, is_active: true } : null },
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
  const dbKey = useDbConnectionKey();
  return useQuery({
    queryKey: ['chart-data', timeRange, dbKey],
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<ChartData[]> => {
      const { legacy, main } = getActiveConn();

      // Non-Supabase via API server — fetch all messages then compute chart
      if (main && shouldUseApiServer(main)) {
        try {
          const creds = buildSessionsCreds(main);
          const { sessions } = await apiPost<{ sessions: { session_id: string; recipient: string; last_message_at: string; message_count: number }[] }>('/api/sessions/list', { creds });
          // Build chart from session timestamps
          const fakeMsgs = sessions.map((s) => ({
            id: s.session_id,
            session_id: s.session_id,
            sender: 'AI' as const,
            message_text: '',
            timestamp: s.last_message_at,
            recipient: s.recipient,
          }));
          return computeChartData(fakeMsgs, timeRange);
        } catch {
          return computeChartData([], timeRange);
        }
      }

      // Supabase via new connection
      if (main && main.dbType === 'supabase' && main.url && main.serviceRoleKey) {
        try {
          const fakeConn = { db_type: 'supabase' as const, supabase_url: main.url, service_role_key: main.serviceRoleKey, host: '', port: '', username: '', password: '', database: '', connection_string: '', table_name: '' };
          const msgs = await queryExternalSupabase(fakeConn, 'sessions');
          return computeChartData(msgs, timeRange);
        } catch {
          return computeChartData([], timeRange);
        }
      }

      // Legacy Supabase
      if (legacy && legacy.db_type === 'supabase' && legacy.supabase_url && legacy.service_role_key) {
        try {
          const msgs = await queryExternalSupabase(legacy, 'sessions');
          return computeChartData(msgs, timeRange);
        } catch {
          return computeChartData([], timeRange);
        }
      }

      // Edge function fallback
      try {
        const { data, error } = await supabase.functions.invoke('get-chat-history', {
          method: 'POST',
          body: { type: 'chart_data', time_range: timeRange, connection: legacy ? { ...legacy, is_active: true } : null },
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
  const { legacy, main } = getActiveConn();

  // Non-Supabase via API server
  if (main && shouldUseApiServer(main)) {
    const creds = buildSessionsCreds(main);
    const { messages } = await apiPost<{ messages: ChatMessage[] }>('/api/sessions/messages', { creds, sessionId });
    return messages;
  }

  // Supabase via new connection
  if (main && main.dbType === 'supabase' && main.url && main.serviceRoleKey) {
    const fakeConn = { db_type: 'supabase' as const, supabase_url: main.url, service_role_key: main.serviceRoleKey, host: '', port: '', username: '', password: '', database: '', connection_string: '', table_name: '' };
    const msgs = await queryExternalSupabase(fakeConn, 'messages', sessionId);
    return msgs.filter((m) => m.session_id === sessionId) as ChatMessage[];
  }

  // Legacy Supabase connection
  if (legacy && legacy.db_type === 'supabase' && legacy.supabase_url && legacy.service_role_key) {
    const msgs = await queryExternalSupabase(legacy, 'messages', sessionId);
    return msgs.filter((m) => m.session_id === sessionId) as ChatMessage[];
  }

  // Edge function fallback
  const { data, error } = await supabase.functions.invoke('get-chat-history', {
    method: 'POST',
    body: { type: 'messages', session_id: sessionId, connection: legacy ? { ...legacy, is_active: true } : null },
  });
  if (error) throw new Error(error.message);
  if (data?.error === 'TABLE_NOT_FOUND') throw new Error('TABLE_NOT_FOUND');
  return (data?.messages ?? []) as ChatMessage[];
}

// ─── useChatHistory ───────────────────────────────────────────────────────────
export const useChatHistory = (sessionId?: string) => {
  const dbKey = useDbConnectionKey();
  return useQuery({
    queryKey: ['chat-history', sessionId, dbKey],
    enabled: !!sessionId,
    retry: 1,
    staleTime: 0,
    gcTime: 5 * 60_000,
    refetchInterval: 3_000,
    refetchIntervalInBackground: false,
    queryFn: () => fetchMessages(sessionId!),
  });
};

// ─── Real-time activity tracker ───────────────────────────────────────────────
// Tracks per-session message counts + the wall-clock time a new message was
// first detected. This lets us show real "last active" times even when the
// database table (e.g. n8n_chat_histories) has no created_at column.
const _activityTracker = new Map<string, { count: number; last_active_at: string }>();

function trackSessionActivity(sessions: { session_id: string; recipient: string; last_message_at: string; message_count: number; is_active: boolean }[]): { session_id: string; recipient: string; last_message_at: string; message_count: number; is_active: boolean }[] {
  const FALLBACK_TS = '2000-01-01T00:00:00.000Z';
  const now = new Date().toISOString();
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  return sessions.map((s) => {
    const tracked = _activityTracker.get(s.session_id);

    if (!tracked) {
      // First time seeing this session — record count but do NOT mark active yet.
      // Use the DB timestamp as the starting last_active_at (may be fallback).
      _activityTracker.set(s.session_id, { count: s.message_count, last_active_at: s.last_message_at });
      return s;
    }

    if (s.message_count > tracked.count) {
      // A new message just arrived — stamp it with the current wall-clock time.
      _activityTracker.set(s.session_id, { count: s.message_count, last_active_at: now });
      return { ...s, last_message_at: now, is_active: true };
    }

    // No new messages — use whatever time we tracked.
    const effectiveTs =
      s.last_message_at === FALLBACK_TS ? tracked.last_active_at : s.last_message_at;
    return {
      ...s,
      last_message_at: effectiveTs,
      is_active: effectiveTs !== FALLBACK_TS && effectiveTs >= fiveMinutesAgo,
    };
  });
}

// ─── useSessions ──────────────────────────────────────────────────────────────
export const useSessions = (filterDate?: Date | null) => {
  const dbKey = useDbConnectionKey();
  return useQuery({
    queryKey: ['sessions', filterDate ? format(filterDate, 'yyyy-MM-dd') : 'all', dbKey],
    staleTime: 5_000,
    refetchInterval: 10_000,
    retry: 1,
    queryFn: async () => {
      const { legacy, main } = getActiveConn();

      // Non-Supabase via API server
      if (main && shouldUseApiServer(main)) {
        try {
          const creds = buildSessionsCreds(main);
          const body: Record<string, unknown> = { creds };
          if (filterDate) body.filterDate = format(filterDate, 'yyyy-MM-dd');
          const { sessions } = await apiPost<{ sessions: { session_id: string; recipient: string; last_message_at: string; message_count: number }[] }>('/api/sessions/list', body);
          const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
          const withActive = sessions.map((s) => ({
            ...s,
            is_active: s.last_message_at >= fiveMinutesAgo,
          })) as SessionInfo[];
          return trackSessionActivity(withActive) as SessionInfo[];
        } catch {
          return [] as SessionInfo[];
        }
      }

      // Supabase via new connection (serviceRoleKey)
      if (main && main.dbType === 'supabase' && main.url && main.serviceRoleKey) {
        try {
          const fakeConn = { db_type: 'supabase' as const, supabase_url: main.url, service_role_key: main.serviceRoleKey, host: '', port: '', username: '', password: '', database: '', connection_string: '', table_name: '' };
          const msgs = await queryExternalSupabase(fakeConn, 'sessions');
          const filtered = filterDate
            ? msgs.filter((m) => {
                try { return format(new Date(m.timestamp), 'yyyy-MM-dd') === format(filterDate, 'yyyy-MM-dd'); }
                catch { return true; }
              })
            : msgs;
          return trackSessionActivity(buildSessionsFromMessages(filtered)) as SessionInfo[];
        } catch (e: unknown) {
          if (e instanceof Error && e.message === 'TABLE_NOT_FOUND') return [] as SessionInfo[];
          throw e;
        }
      }

      // Legacy Supabase connection
      if (legacy && legacy.db_type === 'supabase' && legacy.supabase_url && legacy.service_role_key) {
        try {
          const msgs = await queryExternalSupabase(legacy, 'sessions');
          const filtered = filterDate
            ? msgs.filter((m) => {
                try { return format(new Date(m.timestamp), 'yyyy-MM-dd') === format(filterDate, 'yyyy-MM-dd'); }
                catch { return true; }
              })
            : msgs;
          return trackSessionActivity(buildSessionsFromMessages(filtered)) as SessionInfo[];
        } catch (e: unknown) {
          if (e instanceof Error && e.message === 'TABLE_NOT_FOUND') return [] as SessionInfo[];
          throw e;
        }
      }

      // Edge function fallback
      try {
        const body: Record<string, unknown> = {
          type: 'sessions',
          connection: legacy ? { ...legacy, is_active: true } : null,
        };
        if (filterDate) body.filter_date = format(filterDate, 'yyyy-MM-dd');
        const { data, error } = await supabase.functions.invoke('get-chat-history', {
          method: 'POST',
          body,
        });
        if (error) throw new Error(error.message);
        if (data?.error === 'TABLE_NOT_FOUND') return [] as SessionInfo[];
        return trackSessionActivity((data?.sessions ?? []) as SessionInfo[]) as SessionInfo[];
      } catch {
        return [] as SessionInfo[];
      }
    },
  });
};

// ─── localStorage name cache ──────────────────────────────────────────────────
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
  const dbKey = useDbConnectionKey();
  return useQuery({
    queryKey: ['recipient-names', dbKey],
    staleTime: 15_000,
    gcTime: 30 * 60_000,
    queryFn: async () => {
      const map: Record<string, string> = getLocalNames();
      try {
        const { data } = await supabase
          .from('recipient_names')
          .select('recipient_id, name');
        data?.forEach((item: RecipientName) => {
          map[item.recipient_id] = item.name;
          saveLocalName(item.recipient_id, item.name);
        });
      } catch { /* table may not exist */ }
      return map;
    },
  });
};

const _autoResolveAttemptedAt = new Map<string, number>();
const RETRY_TTL_MS = 5 * 60 * 1000;

interface PlatformConnLike {
  platform: string;
  is_active: boolean;
  access_token: string;
}

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

    unresolved.forEach(r => _autoResolveAttemptedAt.set(r, now));

    Promise.all(
      unresolved.map(async (recipientId): Promise<boolean> => {
        for (const token of tokens) {
          try {
            const convRes = await fetch(
              `https://graph.facebook.com/v19.0/me/conversations?user_id=${recipientId}&fields=participants%7Bname%2Cemail%2Cid%7D&access_token=${token}`
            );
            const convData = await convRes.json();
            const participants: Array<{ id: string; name: string }> =
              convData?.data?.[0]?.participants?.data ?? [];
            const senderParticipant =
              participants.find((p) => p.id === recipientId) ||
              participants.find((p) => p.id !== recipientId);
            const resolvedName = senderParticipant?.name;
            if (resolvedName && !convData.error) {
              saveLocalName(recipientId, resolvedName);
              try {
                await supabase.from('recipient_names').upsert(
                  { recipient_id: recipientId, name: resolvedName, updated_at: new Date().toISOString() },
                  { onConflict: 'recipient_id' }
                );
              } catch { /* ignore */ }
              return true;
            }
          } catch { /* fall through */ }

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
          } catch { /* try next token */ }
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
      saveLocalName(recipientId, name);
      try {
        await supabase.from('recipient_names').upsert(
          { recipient_id: recipientId, name, updated_at: new Date().toISOString() },
          { onConflict: 'recipient_id' }
        );
      } catch { /* ignore */ }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipient-names'] });
    },
  });
};

// ─── fetchNameFromMeta ────────────────────────────────────────────────────────
export async function fetchNameFromMeta(
  recipientId: string,
  tokens: string[]
): Promise<string | null> {
  for (const token of tokens) {
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
