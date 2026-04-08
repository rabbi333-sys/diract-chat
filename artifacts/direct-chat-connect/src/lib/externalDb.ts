/**
 * externalDb.ts
 * Direct browser-side connection to the user's external Supabase project.
 * No edge function needed — uses @supabase/supabase-js with the stored credentials.
 *
 * For PostgreSQL / MySQL / MongoDB / Redis we still call the edge function
 * (those can't be reached from a browser).
 */

import { createClient } from '@supabase/supabase-js';
import { supabase as localSupabase } from '@/integrations/supabase/client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StoredConnection {
  db_type: 'supabase' | 'postgresql' | 'mysql' | 'mongodb' | 'redis';
  supabase_url: string;
  service_role_key: string;
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  connection_string: string;
  table_name: string;
  is_active?: boolean;
}

export interface NormalizedMessage {
  id: string | number;
  session_id: string;
  sender: 'User' | 'AI';
  message_text: string;
  timestamp: string;
  recipient?: string;
}

export interface SessionInfo {
  session_id: string;
  recipient: string;
  last_message_at: string;
  message_count: number;
  is_active: boolean;
}

// ─── localStorage helpers ─────────────────────────────────────────────────────

const STORAGE_KEY = 'chat_monitor_db_settings';

export const getStoredConnection = (): StoredConnection | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredConnection) : null;
  } catch {
    return null;
  }
};

// ─── Row normalizer ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeRow(raw: Record<string, any>): NormalizedMessage | null {
  if (!raw) return null;
  const id = (raw.id ?? raw._id ?? '') as string | number;
  const session_id = String(
    raw.session_id ?? raw.sessionId ?? raw.conversation_id ?? 'unknown'
  );
  const recipient = (raw.recipient ?? raw.to ?? raw.phone ?? undefined) as
    | string
    | undefined;
  const timestamp = String(
    raw.created_at ?? raw.timestamp ?? raw.createdAt ?? new Date().toISOString()
  );

  // n8n native: { message: { type, content|output } }
  if (raw.message && typeof raw.message === 'object') {
    const msg = raw.message as Record<string, unknown>;
    const type = String(msg.type ?? '').toLowerCase();
    const isHuman = type === 'human' || type === 'user';
    const text = isHuman
      ? String(msg.content ?? msg.text ?? msg.body ?? '')
      : String(msg.output ?? msg.content ?? msg.text ?? msg.body ?? '');
    if (!text.trim()) return null;
    return { id, session_id, sender: isHuman ? 'User' : 'AI', message_text: text, timestamp, recipient };
  }

  // Normalized: { sender, message_text }
  if (raw.sender !== undefined && raw.message_text !== undefined) {
    const s = String(raw.sender).toLowerCase();
    const isHuman = ['user', 'human', 'customer'].includes(s);
    const text = String(raw.message_text ?? '');
    if (!text.trim()) return null;
    return { id, session_id, sender: isHuman ? 'User' : 'AI', message_text: text, timestamp, recipient };
  }

  // Role-based: { role, content }
  if (raw.role !== undefined) {
    const role = String(raw.role).toLowerCase();
    const isHuman = ['user', 'human', 'customer'].includes(role);
    const text = String(raw.content ?? raw.text ?? raw.body ?? '');
    if (!text.trim()) return null;
    return { id, session_id, sender: isHuman ? 'User' : 'AI', message_text: text, timestamp, recipient };
  }

  // Generic fallback
  const typeStr = String(raw.type ?? raw.from ?? raw.sender_type ?? '').toLowerCase();
  const isHuman = ['user', 'human', 'customer', 'inbound'].includes(typeStr);
  const text = String(raw.content ?? raw.text ?? raw.body ?? raw.message_text ?? raw.message ?? '');
  if (!text.trim() || text === '{}') return null;
  return { id, session_id, sender: isHuman ? 'User' : 'AI', message_text: text, timestamp, recipient };
}

// ─── Session builder ──────────────────────────────────────────────────────────

export function buildSessionsFromMessages(msgs: NormalizedMessage[]): SessionInfo[] {
  const map = new Map<
    string,
    { recipient: string; last_id: string | number; count: number; last_ts: string }
  >();
  msgs.forEach((m) => {
    const ex = map.get(m.session_id);
    if (!ex) {
      map.set(m.session_id, {
        recipient: m.recipient ?? m.session_id,
        last_id: m.id,
        count: 1,
        last_ts: m.timestamp,
      });
    } else {
      ex.count++;
      if (m.timestamp > ex.last_ts) {
        ex.last_ts = m.timestamp;
        ex.last_id = m.id;
      }
    }
  });
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  return Array.from(map.entries())
    .map(([session_id, info]) => ({
      session_id,
      recipient: info.recipient,
      last_message_at: info.last_ts,
      message_count: info.count,
      is_active: info.last_ts >= fiveMinutesAgo,
    }))
    .sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
}

// ─── Client cache — prevent multiple GoTrueClient instances ──────────────────

const _clientCache = new Map<string, ReturnType<typeof createClient>>();

function getExternalClient(url: string, key: string) {
  const cacheKey = `${url}||${key.slice(-8)}`;
  if (_clientCache.has(cacheKey)) return _clientCache.get(cacheKey)!;
  const client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      // Use a unique storage key so it doesn't conflict with the app's own Supabase auth
      storageKey: `ext-supabase-${url.replace(/https?:\/\//, '').split('.')[0]}`,
    },
  });
  _clientCache.set(cacheKey, client);
  return client;
}

// ─── Direct Supabase query (browser-safe, no edge function) ──────────────────

export async function queryExternalSupabase(
  conn: StoredConnection,
  type: string,
  sessionId?: string | null
): Promise<NormalizedMessage[]> {
  const url = conn.supabase_url?.trim();
  const key = conn.service_role_key?.trim();
  const tbl = (conn.table_name?.trim()) || 'n8n_chat_histories';

  if (!url || !key) throw new Error('Please provide Supabase URL and Service Role Key');

  const client = getExternalClient(url, key);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = client.from(tbl).select('*');
  if (sessionId && type === 'messages') {
    q = q.eq('session_id', sessionId).order('id', { ascending: true }).limit(500);
  } else {
    q = q.order('id', { ascending: false }).limit(2000);
  }

  const { data, error } = await q;

  if (error) {
    const msg = String(error.message ?? '');
    if (
      error.code === '42P01' ||
      msg.toLowerCase().includes('does not exist') ||
      msg.toLowerCase().includes('relation')
    ) {
      throw new Error('TABLE_NOT_FOUND');
    }
    throw new Error(msg || 'Unknown Supabase error');
  }

  return ((data ?? []) as Record<string, unknown>[])
    .map(normalizeRow)
    .filter(Boolean) as NormalizedMessage[];
}

// ─── Validate connection (for Settings page) ─────────────────────────────────

export type ValidationResult = 'ok' | 'table-missing' | 'fail';

export async function validateConnection(conn: StoredConnection): Promise<ValidationResult> {
  if (!conn) return 'fail';

  // ── Supabase: direct browser connection — no edge function needed ─────────
  if (conn.db_type === 'supabase') {
    try {
      await queryExternalSupabase(conn, 'sessions');
      return 'ok';
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'TABLE_NOT_FOUND' || msg.includes('TABLE_NOT_FOUND')) return 'table-missing';
      return 'fail';
    }
  }

  // ── PostgreSQL / MySQL / MongoDB / Redis: try via edge function ───────────
  try {
    const { data, error } = await localSupabase.functions.invoke('get-chat-history', {
      method: 'POST',
      body: { type: 'sessions', connection: { ...conn, is_active: true } },
    });
    if (error) return 'fail';
    if (data?.error === 'TABLE_NOT_FOUND') return 'table-missing';
    if (data?.error) return 'fail';
    return 'ok';
  } catch {
    return 'fail';
  }
}
