/**
 * useRealtimeUpdates — Unified real-time / smart-polling sync hook
 *
 * Adapts its strategy to the active database type:
 *
 *  Supabase   → raw Phoenix WebSocket to Supabase Realtime v2
 *               (bypasses the JS SDK's service_role ban)
 *  MongoDB    → SSE to /api/realtime/stream (server-side change stream)
 *  Redis      → SSE to /api/realtime/stream (server-side pub/sub)
 *  PostgreSQL │
 *  MySQL      → Smart polling every 15–20 s, paused when the tab is hidden
 *
 * Returns { connected, mode } for the LiveSyncBadge:
 *   mode = 'realtime' → green dot
 *   mode = 'polling'  → yellow dot
 *   mode = 'none'     → red dot (or hidden if no DB is configured)
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getStoredConnection, normalizeRow } from '@/lib/externalDb';
import { getActiveConnection } from '@/lib/db-config';
import { appendToMsgCache } from '@/hooks/useChatHistory';

export type SyncMode = 'realtime' | 'polling' | 'none';

type NewMessageCallback = (sessionId: string) => void;

export function useRealtimeUpdates(
  onNewMessage?: NewMessageCallback
): { connected: boolean; mode: SyncMode } {
  const queryClient = useQueryClient();
  const cbRef = useRef(onNewMessage);
  cbRef.current = onNewMessage;

  const [connected, setConnected] = useState(false);
  const [mode, setMode] = useState<SyncMode>('none');

  const handleNewRow = useCallback(
    (rawRow: Record<string, unknown>) => {
      const normalized = normalizeRow(rawRow);
      if (!normalized) return;
      appendToMsgCache(normalized);
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
      queryClient.invalidateQueries({ queryKey: ['chart-data'] });
      queryClient.invalidateQueries({ queryKey: ['chat-history', normalized.session_id] });
      cbRef.current?.(normalized.session_id);
    },
    [queryClient]
  );

  useEffect(() => {
    const active  = getActiveConnection();
    const legacy  = getStoredConnection();
    const dbType  = active?.dbType ?? legacy?.db_type ?? null;

    if (!dbType) {
      setMode('none');
      setConnected(false);
      return;
    }

    // ── SUPABASE ─ raw Phoenix WebSocket ────────────────────────────────────
    if (dbType === 'supabase') {
      const url   = (active?.url ?? legacy?.supabase_url ?? '').trim().replace(/\/$/, '');
      const key   = (active?.serviceRoleKey ?? active?.anonKey ?? legacy?.service_role_key ?? '').trim();
      const table = legacy?.table_name?.trim() || 'n8n_chat_histories';

      if (!url || !key) { setMode('none'); setConnected(false); return; }

      const wsHost    = url.replace(/^https?:\/\//, '');
      const wsUrl     = `wss://${wsHost}/realtime/v1/websocket?apikey=${encodeURIComponent(key)}&vsn=1.0.0`;
      const topic     = `realtime:cm-${table}`;

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
              postgres_changes: [{ event: 'INSERT', schema: 'public', table }],
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
          setConnected(true);
          setMode('realtime');
          join();
          hb = setInterval(() => tx({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: nref() }), 25_000);
        };

        ws.onmessage = (e) => {
          try {
            const m = JSON.parse(e.data as string) as {
              event: string;
              payload?: { data?: { eventType?: string; new?: Record<string, unknown>; commit_timestamp?: string } };
            };
            if (m.event === 'postgres_changes' && m.payload?.data?.eventType === 'INSERT' && m.payload.data.new) {
              const row = { ...m.payload.data.new } as Record<string, unknown>;
              if (!row.created_at && m.payload.data.commit_timestamp) row.created_at = m.payload.data.commit_timestamp;
              handleNewRow(row);
            }
          } catch { /* ignore */ }
        };

        ws.onclose = () => {
          setConnected(false);
          setMode('none');
          if (hb) { clearInterval(hb); hb = null; }
          if (!dead) rt = setTimeout(go, 3_000);
        };

        ws.onerror = () => { ws?.close(); };
      };

      go();
      return () => {
        dead = true;
        setConnected(false);
        setMode('none');
        if (hb) clearInterval(hb);
        if (rt) clearTimeout(rt);
        try { ws?.close(); } catch { /* ignore */ }
      };
    }

    // ── MONGODB / REDIS ─ SSE from API server ───────────────────────────────
    if (dbType === 'mongodb' || dbType === 'redis') {
      const conn = active;
      if (!conn) { setMode('none'); setConnected(false); return; }

      const p = new URLSearchParams({ dbType: conn.dbType });
      if (conn.connectionString) p.set('connectionString', conn.connectionString);
      if (conn.host)             p.set('host', conn.host);
      if (conn.port)             p.set('port', conn.port);
      if (conn.dbUsername)       p.set('dbUsername', conn.dbUsername);
      if (conn.dbPassword)       p.set('dbPassword', conn.dbPassword);
      if (conn.dbName)           p.set('dbName', conn.dbName);

      let es: EventSource | null = null;
      let rt: ReturnType<typeof setTimeout> | null = null;
      let dead = false;

      const go = () => {
        if (dead) return;
        es = new EventSource(`/api/realtime/stream?${p.toString()}`);

        es.onopen = () => { setConnected(true); setMode('realtime'); };

        es.addEventListener('message', (e) => {
          try { handleNewRow(JSON.parse(e.data) as Record<string, unknown>); }
          catch { /* ignore */ }
        });

        es.addEventListener('error', () => {
          es?.close();
          setConnected(false);
          setMode('none');
          if (!dead) rt = setTimeout(go, 5_000);
        });
      };

      go();
      return () => {
        dead = true;
        setConnected(false);
        setMode('none');
        if (rt) clearTimeout(rt);
        es?.close();
      };
    }

    // ── POSTGRESQL / MYSQL ─ Smart polling (tab-active only) ────────────────
    if (dbType === 'postgresql' || dbType === 'mysql') {
      setMode('polling');
      setConnected(true);

      const INTERVAL = 17_000; // 17 s — between 15–20 s as specified
      let timer: ReturnType<typeof setInterval> | null = null;

      const poll = () => {
        if (document.hidden) return; // pause when tab is invisible
        queryClient.invalidateQueries({ queryKey: ['sessions'] });
        queryClient.invalidateQueries({ queryKey: ['analytics'] });
        queryClient.invalidateQueries({ queryKey: ['chart-data'] });
      };

      timer = setInterval(poll, INTERVAL);

      // Fire immediately when tab becomes visible again
      const onVisible = () => { if (!document.hidden) poll(); };
      document.addEventListener('visibilitychange', onVisible);

      return () => {
        setConnected(false);
        setMode('none');
        if (timer) clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisible);
      };
    }

    setMode('none');
    setConnected(false);
  }, [handleNewRow]); // eslint-disable-line react-hooks/exhaustive-deps

  return { connected, mode };
}
