import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { format, subDays, subMonths, startOfWeek, endOfWeek, eachDayOfInterval, parseISO } from 'date-fns';
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
  last_message_text?: string;
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

// ─── Shared message cache (in-memory + localStorage persistence) ──────────────
const LS_RAW      = 'cm_raw_';
const LS_SESSIONS = 'cm_sess_';
const LS_ANALYTICS = 'cm_analytics_';
const LS_CHART    = 'cm_chart_';
const LS_MAX_AGE  = 120_000; // 2 min — localStorage data older than this is ignored
const LS_MAX_MSGS = 2000;    // max messages stored to localStorage
const MSG_CACHE_TTL = 8_000; // in-memory TTL — slightly longer than 5s poll

let _msgCache: NormalizedMessage[] = [];
let _msgCacheKey = '';
let _msgCacheTs = 0;

function lsGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw) as { ts: number; data: T };
    if (Date.now() - ts > LS_MAX_AGE) return null;
    return data;
  } catch { return null; }
}

function lsSet<T>(key: string, data: T) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch { /* storage full */ }
}

function lsTs(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    return (JSON.parse(raw) as { ts: number }).ts ?? 0;
  } catch { return 0; }
}

function setMsgCache(msgs: NormalizedMessage[], key: string) {
  _msgCache = msgs;
  _msgCacheKey = key;
  _msgCacheTs = Date.now();
  lsSet(LS_RAW + key, msgs.slice(0, LS_MAX_MSGS));
}

/**
 * Prepend a single normalized message to the shared in-memory cache.
 * Called by the Realtime subscription when a new INSERT is detected so the
 * UI can update instantly without waiting for the next polling cycle.
 */
export function appendToMsgCache(msg: NormalizedMessage) {
  if (!_msgCacheKey) return; // cache not initialised yet — skip
  // De-duplicate by id, then prepend (newest first, matching order=id.desc)
  _msgCache = [msg, ..._msgCache.filter((m) => String(m.id) !== String(msg.id))];
  _msgCacheTs = Date.now(); // keep TTL alive so next queryFn reads from cache
  lsSet(LS_RAW + _msgCacheKey, _msgCache.slice(0, LS_MAX_MSGS));
}

function getMsgCache(key: string): NormalizedMessage[] | null {
  if (_msgCacheKey === key && Date.now() - _msgCacheTs < MSG_CACHE_TTL && _msgCache.length > 0) {
    return _msgCache;
  }
  const ls = lsGet<NormalizedMessage[]>(LS_RAW + key);
  if (ls && ls.length > 0) {
    _msgCache = ls;
    _msgCacheKey = key;
    _msgCacheTs = lsTs(LS_RAW + key);
    return ls;
  }
  return null;
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

function computeCustomRangeChartData(msgs: NormalizedMessage[], startDate: string, endDate: string): ChartData[] {
  try {
    const start = parseISO(startDate);
    const end   = parseISO(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return [];
    const days = eachDayOfInterval({ start, end });
    // If range > 60 days, group by week; > 180 days, group by month
    if (days.length > 180) {
      const buckets: Record<string, { conversations: Set<string>; messages: number }> = {};
      for (const d of days) {
        const key = format(d, 'MMM yyyy');
        if (!buckets[key]) buckets[key] = { conversations: new Set(), messages: 0 };
      }
      for (const m of msgs) {
        if (m.timestamp === FALLBACK_TS) continue;
        try {
          const d = new Date(m.timestamp);
          if (d < start || d > end) continue;
          const key = format(d, 'MMM yyyy');
          if (buckets[key]) { buckets[key].conversations.add(m.session_id); buckets[key].messages++; }
        } catch { /* skip */ }
      }
      return Object.entries(buckets).map(([label, b]) => ({ label, conversations: b.conversations.size, messages: b.messages }));
    }
    if (days.length > 60) {
      const buckets: Record<string, { conversations: Set<string>; messages: number }> = {};
      for (const d of days) {
        const key = format(startOfWeek(d), 'MMM d');
        if (!buckets[key]) buckets[key] = { conversations: new Set(), messages: 0 };
      }
      for (const m of msgs) {
        if (m.timestamp === FALLBACK_TS) continue;
        try {
          const d = new Date(m.timestamp);
          if (d < start || d > end) continue;
          const key = format(startOfWeek(d), 'MMM d');
          if (buckets[key]) { buckets[key].conversations.add(m.session_id); buckets[key].messages++; }
        } catch { /* skip */ }
      }
      return Object.entries(buckets).map(([label, b]) => ({ label, conversations: b.conversations.size, messages: b.messages }));
    }
    return days.map((d) => {
      const dateStr = format(d, 'yyyy-MM-dd');
      const dayMsgs = msgs.filter((m) => m.timestamp !== FALLBACK_TS && (m.timestamp || '').startsWith(dateStr));
      return { label: format(d, days.length <= 14 ? 'MMM d' : 'MM/dd'), conversations: new Set(dayMsgs.map(m => m.session_id)).size, messages: dayMsgs.length };
    });
  } catch { return []; }
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
  if (main && main.dbType === 'supabase' && main.url && (main.serviceRoleKey || main.anonKey)) {
    const fakeConn = { db_type: 'supabase' as const, supabase_url: main.url, service_role_key: main.serviceRoleKey || main.anonKey, host: '', port: '', username: '', password: '', database: '', connection_string: '', table_name: '' };
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
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    refetchInterval: false,
    retry: 1,
    placeholderData: (prev: any) => prev,
    queryFn: async (): Promise<AnalyticsData> => {
      const cached = getMsgCache(dbKey);
      if (cached) {
        const result = computeAnalytics(cached);
        lsSet(LS_ANALYTICS + dbKey, result);
        return result;
      }

      const { legacy, main } = getActiveConn();

      if (main && shouldUseApiServer(main)) {
        try {
          const creds = buildSessionsCreds(main);
          const data = await apiPost<AnalyticsData>('/api/sessions/analytics', { creds });
          return data;
        } catch {
          return { total_sessions: 0, total_messages: 0, human_messages: 0, ai_messages: 0 };
        }
      }

      if (main && main.dbType === 'supabase' && main.url && (main.serviceRoleKey || main.anonKey)) {
        const fakeConn = { db_type: 'supabase' as const, supabase_url: main.url, service_role_key: main.serviceRoleKey || main.anonKey, host: '', port: '', username: '', password: '', database: '', connection_string: '', table_name: '' };
        try {
          const msgs = await queryExternalSupabase(fakeConn, 'sessions');
          setMsgCache(msgs, dbKey);
          const result = computeAnalytics(msgs);
          lsSet(LS_ANALYTICS + dbKey, result);
          return result;
        } catch {
          return { total_sessions: 0, total_messages: 0, human_messages: 0, ai_messages: 0 };
        }
      }

      if (legacy && legacy.db_type === 'supabase' && legacy.supabase_url && legacy.service_role_key) {
        try {
          const msgs = await queryExternalSupabase(legacy, 'sessions');
          setMsgCache(msgs, dbKey);
          const result = computeAnalytics(msgs);
          lsSet(LS_ANALYTICS + dbKey, result);
          return result;
        } catch {
          return { total_sessions: 0, total_messages: 0, human_messages: 0, ai_messages: 0 };
        }
      }

      try {
        const { data, error } = await supabase.functions.invoke('get-chat-history', {
          method: 'POST',
          body: { type: 'analytics', connection: legacy ? { ...legacy, is_active: true } : null },
        });
        if (error) throw error;
        const result = data as AnalyticsData;
        lsSet(LS_ANALYTICS + dbKey, result);
        return result;
      } catch {
        return { total_sessions: 0, total_messages: 0, human_messages: 0, ai_messages: 0 };
      }
    },
  });
};

// ─── useChartData ─────────────────────────────────────────────────────────────
export const useChartData = (
  timeRange: 'daily' | 'weekly' | 'monthly' | 'custom',
  customStart?: string,
  customEnd?: string,
) => {
  const dbKey = useDbConnectionKey();
  const isCustom = timeRange === 'custom';
  const hasCustomDates = isCustom && !!customStart && !!customEnd;

  const chartLsKey = LS_CHART + timeRange + '_' + (customStart ?? '') + '_' + (customEnd ?? '') + '_' + dbKey;

  return useQuery({
    queryKey: ['chart-data', timeRange, customStart, customEnd, dbKey],
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    refetchInterval: false,
    retry: 1,
    enabled: !isCustom || hasCustomDates,
    placeholderData: (prev: any) => prev,
    queryFn: async (): Promise<ChartData[]> => {
      const effectiveRange = isCustom ? 'daily' : timeRange;
      const { legacy, main } = getActiveConn();

      const compute = (msgs: NormalizedMessage[]) => {
        const result = isCustom && hasCustomDates
          ? computeCustomRangeChartData(msgs, customStart!, customEnd!)
          : computeChartData(msgs, effectiveRange as 'daily' | 'weekly' | 'monthly');
        if (result.length > 0) lsSet(chartLsKey, result);
        return result;
      };

      const cached = getMsgCache(dbKey);
      if (cached) return compute(cached);

      if (main && shouldUseApiServer(main)) {
        try {
          const creds = buildSessionsCreds(main);
          const { sessions } = await apiPost<{ sessions: { session_id: string; recipient: string; last_message_at: string; message_count: number }[] }>('/api/sessions/list', { creds });
          const fakeMsgs = sessions.map((s) => ({
            id: s.session_id,
            session_id: s.session_id,
            sender: 'AI' as const,
            message_text: '',
            timestamp: s.last_message_at,
            recipient: s.recipient,
          }));
          return compute(fakeMsgs);
        } catch {
          return compute([]);
        }
      }

      if (main && main.dbType === 'supabase' && main.url && (main.serviceRoleKey || main.anonKey)) {
        try {
          const fakeConn = { db_type: 'supabase' as const, supabase_url: main.url, service_role_key: main.serviceRoleKey || main.anonKey, host: '', port: '', username: '', password: '', database: '', connection_string: '', table_name: '' };
          const msgs = await queryExternalSupabase(fakeConn, 'sessions');
          setMsgCache(msgs, dbKey);
          return compute(msgs);
        } catch {
          return compute([]);
        }
      }

      if (legacy && legacy.db_type === 'supabase' && legacy.supabase_url && legacy.service_role_key) {
        try {
          const msgs = await queryExternalSupabase(legacy, 'sessions');
          setMsgCache(msgs, dbKey);
          return compute(msgs);
        } catch {
          return compute([]);
        }
      }

      try {
        const { data, error } = await supabase.functions.invoke('get-chat-history', {
          method: 'POST',
          body: { type: 'chart_data', time_range: isCustom ? 'daily' : timeRange, connection: legacy ? { ...legacy, is_active: true } : null },
        });
        if (error) throw error;
        const chartResult = (data as ChartData[]) ?? [];
        if (!isCustom && chartResult.length > 0) lsSet(chartLsKey, chartResult);
        if (isCustom) return compute([]);
        return chartResult;
      } catch {
        return compute([]);
      }
    },
  });
};

// ─── Standalone fetch (reused by useChatHistory + load-more) ──────────────────
// Returns messages in chronological order (oldest first).
// Server returns newest-first (DESC) and we reverse here so pagination is correct:
//   offset=0  → most recent 30 messages (reversed = chronological)
//   offset=30 → the 30 before that (reversed = chronological, prepend to display)
export async function fetchMessages(
  sessionId: string,
  limit = 30,
  offset = 0
): Promise<ChatMessage[]> {
  const { legacy, main } = getActiveConn();

  // Non-Supabase via API server
  if (main && shouldUseApiServer(main)) {
    const creds = buildSessionsCreds(main);
    const { messages } = await apiPost<{ messages: ChatMessage[]; hasMore: boolean }>(
      '/api/sessions/messages',
      { creds, sessionId, limit, offset }
    );
    // Server already returns DESC; reverse so oldest message is first
    return (messages ?? []).reverse();
  }

  // Supabase via new connection
  if (main && main.dbType === 'supabase' && main.url && (main.serviceRoleKey || main.anonKey)) {
    const fakeConn = {
      db_type: 'supabase' as const,
      supabase_url: main.url,
      service_role_key: main.serviceRoleKey || main.anonKey,
      host: '', port: '', username: '', password: '', database: '', connection_string: '', table_name: '',
    };
    const msgs = await queryExternalSupabase(fakeConn, 'messages', sessionId, limit, offset);
    return (msgs.filter((m) => m.session_id === sessionId) as ChatMessage[]).reverse();
  }

  // Legacy Supabase connection
  if (legacy && legacy.db_type === 'supabase' && legacy.supabase_url && legacy.service_role_key) {
    const msgs = await queryExternalSupabase(legacy, 'messages', sessionId, limit, offset);
    return (msgs.filter((m) => m.session_id === sessionId) as ChatMessage[]).reverse();
  }

  // Edge function fallback (no pagination — returns up to 500)
  const { data, error } = await supabase.functions.invoke('get-chat-history', {
    method: 'POST',
    body: { type: 'messages', session_id: sessionId, connection: legacy ? { ...legacy, is_active: true } : null },
  });
  if (error) throw new Error(error.message);
  if (data?.error === 'TABLE_NOT_FOUND') throw new Error('TABLE_NOT_FOUND');
  return (data?.messages ?? []) as ChatMessage[];
}

// ─── fetchMessages with hasMore flag ─────────────────────────────────────────
export async function fetchMessagesPaged(
  sessionId: string,
  limit = 30,
  offset = 0
): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  const msgs = await fetchMessages(sessionId, limit, offset);
  return { messages: msgs, hasMore: msgs.length >= limit };
}

// ─── useChatHistory (initial 30 messages, newest-first reversed to chronological) ─
export const useChatHistory = (sessionId?: string) => {
  const dbKey = useDbConnectionKey();
  return useQuery({
    queryKey: ['chat-history', sessionId, dbKey],
    enabled: !!sessionId,
    retry: 1,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    refetchInterval: false,
    placeholderData: (prev: any) => prev,
    queryFn: () => fetchMessages(sessionId!, 30, 0),
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
  const dateKey = filterDate ? format(filterDate, 'yyyy-MM-dd') : 'all';
  const sessLsKey = LS_SESSIONS + dateKey + '_' + dbKey;

  return useQuery({
    queryKey: ['sessions', dateKey, dbKey],
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    refetchInterval: false,
    retry: 1,
    placeholderData: (prev: any) => prev,
    queryFn: async () => {
      const { legacy, main } = getActiveConn();

      // Non-Supabase via API server
      if (main && shouldUseApiServer(main)) {
        try {
          const creds = buildSessionsCreds(main);
          const body: Record<string, unknown> = { creds };
          if (filterDate) body.filterDate = format(filterDate, 'yyyy-MM-dd');
          const { sessions } = await apiPost<{ sessions: { session_id: string; recipient: string; last_message_at: string; message_count: number; last_message_text?: string }[] }>('/api/sessions/list', body);
          const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
          const withActive = sessions.map((s) => ({
            ...s,
            is_active: s.last_message_at >= fiveMinutesAgo,
          })) as SessionInfo[];
          const result = trackSessionActivity(withActive) as SessionInfo[];
          lsSet(sessLsKey, result);
          return result;
        } catch {
          return [] as SessionInfo[];
        }
      }

      // Supabase via new connection (serviceRoleKey)
      if (main && main.dbType === 'supabase' && main.url && (main.serviceRoleKey || main.anonKey)) {
        try {
          const fakeConn = { db_type: 'supabase' as const, supabase_url: main.url, service_role_key: main.serviceRoleKey || main.anonKey, host: '', port: '', username: '', password: '', database: '', connection_string: '', table_name: '' };
          const msgs = await queryExternalSupabase(fakeConn, 'sessions');
          setMsgCache(msgs, dbKey);
          const filtered = filterDate
            ? msgs.filter((m) => {
                try { return format(new Date(m.timestamp), 'yyyy-MM-dd') === format(filterDate, 'yyyy-MM-dd'); }
                catch { return true; }
              })
            : msgs;
          const result = trackSessionActivity(buildSessionsFromMessages(filtered)) as SessionInfo[];
          lsSet(sessLsKey, result);
          return result;
        } catch {
          return [] as SessionInfo[];
        }
      }

      // Legacy Supabase connection
      if (legacy && legacy.db_type === 'supabase' && legacy.supabase_url && legacy.service_role_key) {
        try {
          const msgs = await queryExternalSupabase(legacy, 'sessions');
          setMsgCache(msgs, dbKey);
          const filtered = filterDate
            ? msgs.filter((m) => {
                try { return format(new Date(m.timestamp), 'yyyy-MM-dd') === format(filterDate, 'yyyy-MM-dd'); }
                catch { return true; }
              })
            : msgs;
          const result = trackSessionActivity(buildSessionsFromMessages(filtered)) as SessionInfo[];
          lsSet(sessLsKey, result);
          return result;
        } catch {
          return [] as SessionInfo[];
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
