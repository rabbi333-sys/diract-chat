/**
 * externalDb.ts
 * Direct browser-side connection to the user's external Supabase project.
 * No edge function needed — uses @supabase/supabase-js with the stored credentials.
 *
 * For PostgreSQL / MySQL / MongoDB / Redis we call the API server
 * (those can't be reached from a browser directly).
 */

import { supabase as localSupabase } from '@/integrations/supabase/client';
import { getActiveConnection } from '@/lib/db-config';

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
  sender: 'User' | 'AI' | 'Agent';
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
  last_message_text?: string;
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
  // Build timestamp: handle ISO strings, numeric Unix timestamps, and embedded message timestamps
  const rawTs =
    raw.created_at ?? raw.timestamp ?? raw.createdAt ??
    raw.updated_at ?? raw.updatedAt ?? raw.date ?? raw.time ??
    // Check inside message JSONB (some n8n formats embed the time there)
    (raw.message && typeof raw.message === 'object'
      ? (raw.message as Record<string, any>).created_at ??
        (raw.message as Record<string, any>).timestamp ??
        (raw.message as Record<string, any>).additional_kwargs?.created_at
      : undefined);
  let timestamp: string;
  if (rawTs == null) {
    timestamp = '2000-01-01T00:00:00.000Z';
  } else if (typeof rawTs === 'number') {
    // Unix timestamp — could be seconds (10 digits) or milliseconds (13 digits)
    const ms = rawTs > 1e10 ? rawTs : rawTs * 1000;
    timestamp = new Date(ms).toISOString();
  } else {
    timestamp = String(rawTs);
  }

  // n8n / LangChain native: { message: { type, data: { content } } }
  // Also handles older formats: { message: { type, content|output } }
  if (raw.message && typeof raw.message === 'object') {
    const msg = raw.message as Record<string, any>;
    const type = String(msg.type ?? '').toLowerCase();
    const isHuman = type === 'human' || type === 'user';
    const isAi = type === 'ai' || type === 'assistant';
    const isAgent = type === 'agent' || type === 'human_agent';
    // LangChain stores text inside data.content; fallback to top-level fields
    const data = msg.data as Record<string, unknown> | undefined;
    const text = String(
      data?.content ??
      msg.content ??
      msg.output ??
      msg.text ??
      msg.body ??
      ''
    );
    if (!text.trim()) return null;
    const sender = isHuman ? 'User' : isAi ? 'AI' : isAgent ? 'Agent' : 'AI';
    return { id, session_id, sender, message_text: text, timestamp, recipient };
  }

  // Normalized: { sender, message_text }
  if (raw.sender !== undefined && raw.message_text !== undefined) {
    const s = String(raw.sender).toLowerCase();
    const isHuman = ['user', 'human', 'customer'].includes(s);
    const isAgent = ['agent', 'human_agent', 'operator'].includes(s);
    const text = String(raw.message_text ?? '');
    if (!text.trim()) return null;
    return { id, session_id, sender: isHuman ? 'User' : isAgent ? 'Agent' : 'AI', message_text: text, timestamp, recipient };
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
    { recipient: string; last_id: string | number; count: number; last_ts: string; last_text: string }
  >();
  msgs.forEach((m) => {
    const ex = map.get(m.session_id);
    if (!ex) {
      map.set(m.session_id, {
        recipient: m.recipient ?? m.session_id,
        last_id: m.id,
        count: 1,
        last_ts: m.timestamp,
        last_text: m.message_text || '',
      });
    } else {
      ex.count++;
      if (m.timestamp > ex.last_ts) {
        ex.last_ts = m.timestamp;
        ex.last_id = m.id;
        ex.last_text = m.message_text || '';
      } else if (m.timestamp === ex.last_ts && String(m.id) > String(ex.last_id)) {
        ex.last_id = m.id;
        ex.last_text = m.message_text || '';
      }
    }
  });
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const FALLBACK_TS = '2000-01-01T00:00:00.000Z';
  const sessions = Array.from(map.entries()).map(([session_id, info]) => ({
    session_id,
    recipient: info.recipient,
    last_message_at: info.last_ts,
    last_id: info.last_id,
    message_count: info.count,
    is_active: info.last_ts >= fiveMinutesAgo,
    last_message_text: info.last_text,
  }));
  // If no real timestamps exist, sort by the highest row-id (more recent inserts first)
  const allFallback = sessions.every(s => s.last_message_at === FALLBACK_TS);
  if (allFallback) {
    sessions.sort((a, b) => {
      const ia = typeof a.last_id === 'number' ? a.last_id : parseInt(String(a.last_id)) || 0;
      const ib = typeof b.last_id === 'number' ? b.last_id : parseInt(String(b.last_id)) || 0;
      return ib - ia;
    });
  } else {
    sessions.sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
  }
  return sessions.map(({ last_id: _lid, ...s }) => s);
}

// ─── Raw Supabase REST fetch — bypasses @supabase/supabase-js entirely ────────
// This avoids the "Forbidden use of secret API key in browser" error that newer
// versions of the Supabase JS SDK throw when a service_role key is used in a
// browser context. The underlying protocol is identical: Bearer token + apikey.

function sbHeaders(key: string, extra?: Record<string, string>): HeadersInit {
  return { 'Authorization': `Bearer ${key}`, 'apikey': key, 'Content-Type': 'application/json', ...extra };
}

function sbRestUrl(baseUrl: string, table: string, params?: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}/rest/v1/${table}${params ? '?' + params : ''}`;
}

function isTableMissing(body: string, status: number): boolean {
  if (status === 404) return true;
  try {
    const j = JSON.parse(body) as { code?: string; message?: string };
    if (j.code === '42P01') return true;
    const m = (j.message ?? '').toLowerCase();
    if (m.includes('does not exist') || m.includes('relation')) return true;
  } catch {}
  return false;
}

// ─── Auto-extract contact names from raw DB rows ─────────────────────────────

const _NAME_FIELDS = ['name', 'sender_name', 'contact_name', 'profile_name', 'from_name', 'display_name', 'customer_name'] as const;

/**
 * Scans raw database rows for any contact name fields and upserts them
 * into the local Supabase `recipient_names` table.
 * Runs as a silent background side-effect — all errors are swallowed.
 */
async function autoExtractAndSaveNames(rows: Record<string, unknown>[]): Promise<void> {
  const toSave: { recipient_id: string; name: string; updated_at: string }[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const sessionId = String(row.session_id ?? '').trim();
    if (!sessionId || seen.has(sessionId)) continue;
    if (!/^\d+$/.test(sessionId)) continue; // only pure-numeric IDs (phone numbers / PSIDs)

    let name = '';

    // 1. Check top-level name fields
    for (const field of _NAME_FIELDS) {
      const val = row[field];
      if (typeof val === 'string' && val.trim() && val.trim() !== sessionId) {
        name = val.trim();
        break;
      }
    }

    // 2. Check inside message JSONB (n8n format)
    if (!name && row.message && typeof row.message === 'object') {
      const msg = row.message as Record<string, unknown>;
      const addl = msg.additional_kwargs;
      const addlName = typeof addl === 'object' && addl ? (addl as Record<string, unknown>).name : undefined;
      for (const c of [msg.name, msg.from_name, msg.sender_name, addlName]) {
        if (typeof c === 'string' && c.trim() && c.trim() !== sessionId) {
          name = c.trim();
          break;
        }
      }
    }

    if (name) {
      seen.add(sessionId);
      toSave.push({ recipient_id: sessionId, name, updated_at: new Date().toISOString() });
    }
  }

  if (toSave.length === 0) return;
  await localSupabase.from('recipient_names').upsert(toSave, { onConflict: 'recipient_id' });
}

// ─── Direct Supabase query (browser-safe via raw REST fetch) ─────────────────

export async function queryExternalSupabase(
  conn: StoredConnection,
  type: string,
  sessionId?: string | null
): Promise<NormalizedMessage[]> {
  const url = conn.supabase_url?.trim();
  const key = conn.service_role_key?.trim();
  const tbl = (conn.table_name?.trim()) || 'n8n_chat_histories';

  if (!url || !key) throw new Error('Please provide Supabase URL and Service Role Key');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  let params: string;
  if (sessionId && type === 'messages') {
    params = `select=*&session_id=eq.${encodeURIComponent(sessionId)}&order=id.asc&limit=500`;
  } else {
    params = 'select=*&order=id.desc&limit=2000';
  }

  try {
    const res = await fetch(sbRestUrl(url, tbl, params), {
      headers: sbHeaders(key),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const body = await res.text();
    if (!res.ok) {
      if (isTableMissing(body, res.status)) throw new Error('TABLE_NOT_FOUND');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 120)}`);
    }

    const rows = (JSON.parse(body) ?? []) as Record<string, unknown>[];

    // Side effect: extract contact names and save to local recipient_names table
    if (!sessionId && rows.length > 0) {
      autoExtractAndSaveNames(rows).catch(() => {});
    }

    return rows.map(normalizeRow).filter(Boolean) as NormalizedMessage[];
  } catch (e: unknown) {
    clearTimeout(timeoutId);
    if (e instanceof Error && e.name === 'AbortError') throw new Error('QUERY_TIMEOUT');
    throw e;
  }
}

// ─── Insert agent reply into external DB ─────────────────────────────────────

export interface AgentMessage {
  session_id: string;
  sender: 'Agent';
  message_text: string;
  timestamp: string;
  recipient?: string;
}

// Cache which insert format worked per table so we don't retry both every time
const _insertFormatCache = new Map<string, 'n8n' | 'normalized'>();

/**
 * Silently writes an agent reply to the user's connected external database.
 * Supabase: direct browser connection. PostgreSQL/MySQL/MongoDB/Redis: via API server.
 *
 * All errors are caught and suppressed — this must never block the send flow.
 */
export async function insertMessageToExternalDb(
  conn: StoredConnection | null,
  message: AgentMessage
): Promise<void> {
  // Check if we have a non-Supabase active connection — use API server
  const activeConn = getActiveConnection();
  if (activeConn && activeConn.dbType !== 'supabase') {
    try {
      const creds = {
        dbType: activeConn.dbType,
        host: activeConn.host,
        port: activeConn.port,
        dbUsername: activeConn.dbUsername,
        dbPassword: activeConn.dbPassword,
        dbName: activeConn.dbName,
        connectionString: activeConn.connectionString,
      };
      await fetch('/api/sessions/insert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creds, message: { session_id: message.session_id, message_text: message.message_text, recipient: message.recipient, timestamp: message.timestamp } }),
      });
    } catch { /* silent */ }
    return;
  }

  if (!conn || conn.db_type !== 'supabase') return;
  try {
    const url = conn.supabase_url?.trim();
    const key = conn.service_role_key?.trim();
    const tbl = (conn.table_name?.trim()) || 'n8n_chat_histories';
    if (!url || !key) return;

    const cacheKey = `${url}::${tbl}`;
    const knownFormat = _insertFormatCache.get(cacheKey);
    const hdrs = sbHeaders(key, { 'Prefer': 'return=minimal' });
    const endpoint = sbRestUrl(url, tbl);

    if (knownFormat === 'normalized') {
      await fetch(endpoint, {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({
          session_id: message.session_id,
          sender: 'agent',
          message_text: message.message_text,
          recipient: message.recipient,
          created_at: message.timestamp,
        }),
      });
      return;
    }

    // Try n8n / LangChain format first (default)
    const r1 = await fetch(endpoint, {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({
        session_id: message.session_id,
        message: { type: 'ai', data: { content: message.message_text, additional_kwargs: {} } },
      }),
    });

    if (r1.ok || r1.status === 201) {
      _insertFormatCache.set(cacheKey, 'n8n');
      return;
    }

    // Fallback: normalized format
    const r2 = await fetch(endpoint, {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({
        session_id: message.session_id,
        sender: 'agent',
        message_text: message.message_text,
        recipient: message.recipient,
        created_at: message.timestamp,
      }),
    });

    if (r2.ok || r2.status === 201) {
      _insertFormatCache.set(cacheKey, 'normalized');
    }
  } catch {
    // Silent — never surface DB write errors to the agent
  }
}

// ─── Validate connection (for Settings page) ─────────────────────────────────

export type ValidationResult = 'ok' | 'table-missing' | 'fail';
export interface ValidationDetail { status: ValidationResult; errorMsg?: string }

export async function validateConnection(conn: StoredConnection): Promise<ValidationDetail> {
  if (!conn) return { status: 'fail', errorMsg: 'No connection settings found' };

  // ── Supabase: lightweight single-row ping — much faster than full query ────
  if (conn.db_type === 'supabase') {
    const url = conn.supabase_url?.trim();
    const key = conn.service_role_key?.trim();
    const tbl = conn.table_name?.trim() || 'n8n_chat_histories';

    if (!url || !key) return { status: 'fail', errorMsg: 'Supabase URL and Service Role Key are required.' };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20_000);

      // Lightweight 1-row ping — fast even on a cold-start Supabase project
      const res = await fetch(sbRestUrl(url, tbl, 'select=id&limit=1'), {
        headers: sbHeaders(key),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));

      const body = await res.text();
      if (!res.ok) {
        if (isTableMissing(body, res.status)) return { status: 'table-missing' };
        let errMsg = body;
        try { errMsg = (JSON.parse(body) as { message?: string }).message ?? body; } catch {}
        console.error('[Chat Monitor] Connection test error:', errMsg);
        return { status: 'fail', errorMsg: errMsg };
      }

      return { status: 'ok' };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Chat Monitor] Connection test error:', msg);
      if (e instanceof Error && e.name === 'AbortError') {
        return {
          status: 'fail',
          errorMsg: 'Connection timed out. Your Supabase project may be paused — visit app.supabase.com and resume it, then try again.',
        };
      }
      return { status: 'fail', errorMsg: msg };
    }
  }

  // ── PostgreSQL / MySQL / MongoDB / Redis: try via API server ─────────────
  try {
    const creds = {
      dbType: conn.db_type,
      host: conn.host,
      port: conn.port,
      dbUsername: conn.username,
      dbPassword: conn.password,
      dbName: conn.database,
      connectionString: conn.connection_string,
    };
    const res = await fetch('/api/sessions/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creds }),
    });
    const data = await res.json() as { status?: string; error?: string };
    if (data.status === 'ok') return { status: 'ok' };
    if (data.status === 'table-missing') return { status: 'table-missing' };
    return { status: 'fail', errorMsg: data.error ?? 'Server returned an error' };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 'fail', errorMsg: msg };
  }
}
