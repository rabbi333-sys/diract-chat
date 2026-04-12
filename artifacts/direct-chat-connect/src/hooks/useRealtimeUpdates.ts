/**
 * useRealtimeUpdates — Unified real-time / smart-polling sync hook
 *
 * Strategy by DB type:
 *  Supabase   → raw Phoenix WebSocket to Supabase Realtime v2
 *  MongoDB    → SSE to /api/realtime/stream (change stream)
 *  Redis      → SSE to /api/realtime/stream (pub/sub)
 *  PostgreSQL │
 *  MySQL      → Smart polling every 15 s — auto-pauses when tab is hidden
 *
 * Returns { connected, mode, paused }:
 *   mode='realtime' + connected → Live (green)
 *   mode='polling'  + connected + !paused → Polling (yellow)
 *   mode='polling'  + paused   → Paused (amber) — tab is inactive
 *   connected=false            → Disconnected (red)
 *
 * On new INSERT: appends the message directly to the React Query
 * ['chat-history', sessionId] cache — no network round-trip.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getStoredConnection, normalizeRow } from '@/lib/externalDb';
import { getActiveConnection } from '@/lib/db-config';
import type { ChatMessage } from '@/hooks/useChatHistory';

export type SyncMode = 'realtime' | 'polling' | 'none';

type NewMessageCallback = (sessionId: string) => void;

export function useRealtimeUpdates(
  onNewMessage?: NewMessageCallback
): { connected: boolean; mode: SyncMode; paused: boolean } {
  const queryClient = useQueryClient();
  const cbRef = useRef(onNewMessage);
  cbRef.current = onNewMessage;

  const [connected, setConnected] = useState(false);
  const [mode, setMode]           = useState<SyncMode>('none');
  const [paused, setPaused]       = useState(false);

  const handleNewRow = useCallback(
    (rawRow: Record<string, unknown>) => {
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

      // Append to the existing React Query cache — no DB round-trip
      queryClient.setQueriesData<ChatMessage[]>(
        { queryKey: ['chat-history', normalized.session_id], exact: false },
        (old) => {
          if (!Array.isArray(old)) return old;
          if (old.some((m) => String(m.id) === String(chatMsg.id))) return old;
          return [...old, chatMsg];
        }
      );

      // Sessions sidebar + analytics need a fresh count
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
      queryClient.invalidateQueries({ queryKey: ['chart-data'] });

      cbRef.current?.(normalized.session_id);
    },
    [queryClient]
  );

  useEffect(() => {
    const active = getActiveConnection();
    const legacy = getStoredConnection();
    const dbType = active?.dbType ?? legacy?.db_type ?? null;

    if (!dbType) {
      setMode('none');
      setConnected(false);
      setPaused(false);
      return;
    }

    // ── SUPABASE ─ raw Phoenix WebSocket ────────────────────────────────────
    if (dbType === 'supabase') {
      const url   = (active?.url ?? legacy?.supabase_url ?? '').trim().replace(/\/$/, '');
      const key   = (active?.serviceRoleKey ?? active?.anonKey ?? legacy?.service_role_key ?? '').trim();
      const table = legacy?.table_name?.trim() || 'n8n_chat_histories';

      if (!url || !key) { setMode('none'); setConnected(false); setPaused(false); return; }

      const wsHost = url.replace(/^https?:\/\//, '');
      const wsUrl  = `wss://${wsHost}/realtime/v1/websocket?apikey=${encodeURIComponent(key)}&vsn=1.0.0`;
      const topic  = `realtime:cm-${table}`;

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
          setConnected(true); setMode('realtime'); setPaused(false);
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

    // ── MONGODB / REDIS ─ SSE from API server ───────────────────────────────
    if (dbType === 'mongodb' || dbType === 'redis') {
      const conn = active;
      if (!conn) { setMode('none'); setConnected(false); setPaused(false); return; }

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
        es.onopen = () => { setConnected(true); setMode('realtime'); setPaused(false); };
        es.addEventListener('message', (e) => {
          try { handleNewRow(JSON.parse(e.data) as Record<string, unknown>); }
          catch { /* ignore */ }
        });
        es.addEventListener('error', () => {
          es?.close();
          setConnected(false); setMode('none');
          if (!dead) rt = setTimeout(go, 5_000);
        });
      };

      go();
      return () => {
        dead = true;
        setConnected(false); setMode('none'); setPaused(false);
        if (rt) clearTimeout(rt);
        es?.close();
      };
    }

    // ── POSTGRESQL / MYSQL ─ Smart polling (pauses when tab is hidden) ───────
    if (dbType === 'postgresql' || dbType === 'mysql') {
      setMode('polling');
      setConnected(true);
      setPaused(document.hidden);

      const INTERVAL = 15_000;
      let timer: ReturnType<typeof setInterval> | null = null;

      const poll = () => {
        if (document.hidden) return;
        queryClient.invalidateQueries({ queryKey: ['sessions'] });
        queryClient.invalidateQueries({ queryKey: ['analytics'] });
        queryClient.invalidateQueries({ queryKey: ['chart-data'] });
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

    setMode('none');
    setConnected(false);
    setPaused(false);
  }, [handleNewRow]); // eslint-disable-line react-hooks/exhaustive-deps

  return { connected, mode, paused };
}
