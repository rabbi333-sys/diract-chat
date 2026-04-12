/**
 * useRealtimeUpdates — Global Real-time Sync Engine
 *
 * Covers ALL dashboard modules: Messages, Orders, Failed, Handoff, Overview.
 *
 * Strategy by DB type:
 *  Supabase   → Phoenix WebSocket — postgres_changes on ALL relevant tables
 *  MongoDB    → SSE to /api/realtime/stream — watches multiple collections
 *  Redis      → SSE to /api/realtime/stream — subscribes to multiple channels
 *  PostgreSQL │
 *  MySQL      → Smart polling every 15 s — active module is polled immediately
 *               on tab resume or module switch; auto-pauses when tab is hidden
 *
 * Returns { connected, mode, paused }:
 *   mode='realtime' + connected → Live (green)
 *   mode='polling'  + connected + !paused → Polling (yellow)
 *   mode='polling'  + paused   → Paused (amber) — tab is inactive
 *   connected=false            → Disconnected (red)
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getStoredConnection, normalizeRow } from '@/lib/externalDb';
import { getActiveConnection } from '@/lib/db-config';
import type { ChatMessage } from '@/hooks/useChatHistory';

export type SyncMode = 'realtime' | 'polling' | 'none';

// Query keys invalidated per table event
const TABLE_QUERY_KEYS: Record<string, string[][]> = {
  // chat messages
  n8n_chat_histories: [['sessions'], ['analytics'], ['chart-data']],
  // orders
  orders:             [['supabase-orders'], ['local-orders']],
  // failed jobs
  failed_automations: [['supabase-failures'], ['local-failures']],
  // human handoff
  handoff_requests:   [['supabase-handoffs'], ['local-handoffs']],
};

// All non-chat module query keys (invalidated on polling ticks)
const MODULE_QUERY_KEYS = [
  ['sessions'], ['analytics'], ['chart-data'],
  ['supabase-orders'],
  ['supabase-failures'],
  ['supabase-handoffs'],
];

type GlobalSyncCallbacks = {
  onNewMessage?: (sessionId: string) => void;
  onNewOrder?:   () => void;
  onNewFailure?: () => void;
  onNewHandoff?: () => void;
  /** The currently visible dashboard module — used to prioritise polling */
  activeModule?: string;
};

export function useRealtimeUpdates(
  onNewMessageOrOpts?: ((sessionId: string) => void) | GlobalSyncCallbacks,
): { connected: boolean; mode: SyncMode; paused: boolean } {
  const queryClient = useQueryClient();

  // Normalise the overloaded first argument
  const opts: GlobalSyncCallbacks =
    typeof onNewMessageOrOpts === 'function'
      ? { onNewMessage: onNewMessageOrOpts }
      : (onNewMessageOrOpts ?? {});

  const cbRef = useRef(opts);
  cbRef.current = opts;

  const [connected, setConnected] = useState(false);
  const [mode, setMode]           = useState<SyncMode>('none');
  const [paused, setPaused]       = useState(false);

  // ── Dispatch a raw DB row to the correct cache / callbacks ──────────────────
  const handleNewRow = useCallback(
    (rawRow: Record<string, unknown>, tableHint?: string) => {
      // Determine which "table" this belongs to
      const syncTable =
        tableHint ||
        (rawRow._syncTable as string | undefined) ||
        'n8n_chat_histories';

      // Invalidate the relevant React Query keys
      const keys = TABLE_QUERY_KEYS[syncTable] ?? TABLE_QUERY_KEYS['n8n_chat_histories'];
      for (const key of keys) {
        queryClient.invalidateQueries({ queryKey: key });
      }

      if (syncTable === 'orders') {
        cbRef.current.onNewOrder?.();
        return;
      }
      if (syncTable === 'failed_automations') {
        cbRef.current.onNewFailure?.();
        return;
      }
      if (syncTable === 'handoff_requests') {
        cbRef.current.onNewHandoff?.();
        return;
      }

      // ── Chat message — also append to message cache ─────────────────────────
      const normalized = normalizeRow(rawRow);
      if (!normalized) return;

      const chatMsg: ChatMessage = {
        id: normalized.id,
        session_id: normalized.session_id,
        sender: normalized.sender,
        message_text: normalized.message_text,
        timestamp: normalized.timestamp,
        recipient: normalized.recipient,
      };

      // Append to the React Query cache — no DB round-trip
      queryClient.setQueriesData<ChatMessage[]>(
        { queryKey: ['chat-history', normalized.session_id], exact: false },
        (old) => {
          if (!Array.isArray(old)) return old;
          if (old.some((m) => String(m.id) === String(chatMsg.id))) return old;
          return [...old, chatMsg];
        }
      );

      // Analytics counters need a refresh too
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
      queryClient.invalidateQueries({ queryKey: ['chart-data'] });

      cbRef.current.onNewMessage?.(normalized.session_id);
    },
    [queryClient]
  );

  useEffect(() => {
    const active = getActiveConnection();
    const legacy = getStoredConnection();
    const dbType = active?.dbType ?? legacy?.db_type ?? null;

    if (!dbType) {
      setMode('none'); setConnected(false); setPaused(false);
      return;
    }

    // ── SUPABASE ─ Phoenix WebSocket — listens to ALL relevant tables ──────────
    if (dbType === 'supabase') {
      const url   = (active?.url ?? legacy?.supabase_url ?? '').trim().replace(/\/$/, '');
      const key   = (active?.serviceRoleKey ?? active?.anonKey ?? legacy?.service_role_key ?? '').trim();
      const chatTable = legacy?.table_name?.trim() || 'n8n_chat_histories';

      if (!url || !key) { setMode('none'); setConnected(false); setPaused(false); return; }

      const wsHost = url.replace(/^https?:\/\//, '');
      const wsUrl  = `wss://${wsHost}/realtime/v1/websocket?apikey=${encodeURIComponent(key)}&vsn=1.0.0`;

      // One combined topic for all tables we want to watch
      const topic = `realtime:cm-global-sync`;

      let ws: WebSocket | null = null;
      let hb: ReturnType<typeof setInterval>  | null = null;
      let rt: ReturnType<typeof setTimeout>   | null = null;
      let ref = 0;
      let dead = false;

      const nref = () => String(++ref);

      const tx = (msg: object) => {
        if (ws?.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
        }
      };

      const join = () => {
        const r = nref();
        tx({
          topic, event: 'phx_join',
          payload: {
            config: {
              broadcast: { ack: false, self: false },
              presence: { key: '' },
              postgres_changes: [
                { event: 'INSERT', schema: 'public', table: chatTable },
                { event: 'INSERT', schema: 'public', table: 'orders' },
                { event: 'INSERT', schema: 'public', table: 'failed_automations' },
                { event: 'INSERT', schema: 'public', table: 'handoff_requests' },
                { event: 'UPDATE', schema: 'public', table: 'orders' },
                { event: 'UPDATE', schema: 'public', table: 'failed_automations' },
                { event: 'UPDATE', schema: 'public', table: 'handoff_requests' },
              ],
            },
            access_token: key,
          },
          ref: r, join_ref: r,
        });
      };

      const go = () => {
        if (dead) return;
        try { ws = new WebSocket(wsUrl); }
        catch { if (!dead) rt = setTimeout(go, 5_000); return; }

        ws.onopen = () => {
          setConnected(true); setMode('realtime'); setPaused(false);
          join();
          hb = setInterval(() => tx({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: nref() }), 25_000);
        };

        ws.onmessage = (e) => {
          try {
            const m = JSON.parse(e.data as string) as {
              event: string;
              payload?: {
                data?: {
                  eventType?: string;
                  new?: Record<string, unknown>;
                  commit_timestamp?: string;
                  table?: string;
                };
              };
            };
            if (m.event === 'postgres_changes' && m.payload?.data?.new) {
              const { eventType, new: row, commit_timestamp, table } = m.payload.data;
              if ((eventType === 'INSERT' || eventType === 'UPDATE') && row) {
                const enriched = { ...row } as Record<string, unknown>;
                if (!enriched.created_at && commit_timestamp) enriched.created_at = commit_timestamp;
                handleNewRow(enriched, table ?? chatTable);
              }
            }
          } catch { /* ignore */ }
        };

        ws.onclose = () => {
          setConnected(false); setMode('none');
          if (hb) { clearInterval(hb); hb = null; }
          if (!dead) rt = setTimeout(go, 3_000);
        };

        ws.onerror = () => { ws?.close(); };
      };

      go();
      return () => {
        dead = true;
        setConnected(false); setMode('none'); setPaused(false);
        if (hb) clearInterval(hb);
        if (rt) clearTimeout(rt);
        try { ws?.close(); } catch { /* ignore */ }
      };
    }

    // ── MONGODB / REDIS ─ SSE — watches multiple collections/channels ──────────
    if (dbType === 'mongodb' || dbType === 'redis') {
      const conn = active;
      if (!conn) { setMode('none'); setConnected(false); setPaused(false); return; }

      let es: EventSource | null = null;
      let rt: ReturnType<typeof setTimeout> | null = null;
      let dead = false;

      const go = async () => {
        if (dead) return;

        // Step 1: POST credentials to get a short-lived token (never put creds in URL)
        const initBody: Record<string, string> = { dbType: conn.dbType };
        if (conn.connectionString) initBody.connectionString = conn.connectionString;
        if (conn.host)             initBody.host = conn.host;
        if (conn.port)             initBody.port = conn.port;
        if (conn.dbUsername)       initBody.dbUsername = conn.dbUsername;
        if (conn.dbPassword)       initBody.dbPassword = conn.dbPassword;
        if (conn.dbName)           initBody.dbName = conn.dbName;

        if (dbType === 'mongodb') {
          const chatCollection = legacy?.table_name?.trim() || 'n8n_chat_histories';
          initBody.tables = [chatCollection, 'orders', 'failed_automations', 'handoff_requests'].join(',');
        } else {
          initBody.channels = 'chat_new_message,new_order,new_failure,new_handoff';
        }

        let token: string;
        try {
          const initRes = await fetch('/api/realtime/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(initBody),
          });
          if (!initRes.ok) { if (!dead) rt = setTimeout(go, 5_000); return; }
          const data = await initRes.json() as { token?: string };
          if (!data.token) { if (!dead) rt = setTimeout(go, 5_000); return; }
          token = data.token;
        } catch {
          if (!dead) rt = setTimeout(go, 5_000);
          return;
        }

        if (dead) return;

        // Step 2: Connect SSE using the token only — credentials stay server-side
        es = new EventSource(`/api/realtime/stream?token=${encodeURIComponent(token)}`);
        es.onopen = () => { setConnected(true); setMode('realtime'); setPaused(false); };
        es.addEventListener('message', (e) => {
          try {
            const parsed = JSON.parse(e.data) as Record<string, unknown>;
            handleNewRow(parsed, parsed._syncTable as string | undefined);
          } catch { /* ignore */ }
        });
        es.addEventListener('error', () => {
          es?.close();
          setConnected(false); setMode('none');
          if (!dead) rt = setTimeout(go, 5_000);
        });
      };

      void go();
      return () => {
        dead = true;
        setConnected(false); setMode('none'); setPaused(false);
        if (rt) clearTimeout(rt);
        es?.close();
      };
    }

    // ── POSTGRESQL / MYSQL ─ Smart polling — pauses when tab hidden ───────────
    if (dbType === 'postgresql' || dbType === 'mysql') {
      setMode('polling'); setConnected(true); setPaused(document.hidden);

      const INTERVAL = 15_000;
      let timer: ReturnType<typeof setInterval> | null = null;

      const poll = () => {
        if (document.hidden) return;
        // Invalidate all module query keys on every tick
        for (const key of MODULE_QUERY_KEYS) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      };

      timer = setInterval(poll, INTERVAL);

      const onVisibility = () => {
        if (document.hidden) {
          setPaused(true);
        } else {
          setPaused(false);
          poll(); // immediate catch-up on tab resume
        }
      };
      document.addEventListener('visibilitychange', onVisibility);

      return () => {
        setConnected(false); setMode('none'); setPaused(false);
        if (timer) clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisibility);
      };
    }

    setMode('none'); setConnected(false); setPaused(false);
  }, [handleNewRow]); // eslint-disable-line react-hooks/exhaustive-deps

  return { connected, mode, paused };
}
