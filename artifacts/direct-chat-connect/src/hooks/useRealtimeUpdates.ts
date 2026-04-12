/**
 * useRealtimeUpdates
 *
 * Opens a raw WebSocket to Supabase Realtime and subscribes to INSERT events
 * on the user's configured n8n_chat_histories table.
 *
 * Why raw WebSocket instead of @supabase/supabase-js?
 * The newer Supabase JS SDK throws "Forbidden use of secret API key in browser"
 * when a service_role key is detected at createClient() time. We bypass this
 * by connecting directly to the Phoenix WebSocket endpoint with the key as a
 * query parameter — identical to what the SDK does internally.
 */

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getStoredConnection, normalizeRow } from '@/lib/externalDb';
import { getActiveConnection } from '@/lib/db-config';
import { appendToMsgCache } from '@/hooks/useChatHistory';

type NewMessageCallback = (sessionId: string) => void;

function getRealtimeConn(): { url: string; key: string; table: string } | null {
  const active = getActiveConnection();
  if (active && active.dbType === 'supabase' && active.url && (active.serviceRoleKey || active.anonKey)) {
    return {
      url: active.url.trim().replace(/\/$/, ''),
      key: (active.serviceRoleKey || active.anonKey).trim(),
      table: 'n8n_chat_histories',
    };
  }
  const legacy = getStoredConnection();
  if (legacy && legacy.db_type === 'supabase' && legacy.supabase_url && legacy.service_role_key) {
    return {
      url: legacy.supabase_url.trim().replace(/\/$/, ''),
      key: legacy.service_role_key.trim(),
      table: legacy.table_name?.trim() || 'n8n_chat_histories',
    };
  }
  return null;
}

export function useRealtimeUpdates(onNewMessage?: NewMessageCallback): { connected: boolean } {
  const queryClient = useQueryClient();
  const cbRef = useRef(onNewMessage);
  cbRef.current = onNewMessage;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const conn = getRealtimeConn();
    if (!conn) return;

    const { url, key, table } = conn;
    const wsHost = url.replace(/^https?:\/\//, '');
    const wsEndpoint = `wss://${wsHost}/realtime/v1/websocket?apikey=${encodeURIComponent(key)}&vsn=1.0.0`;
    const channelTopic = `realtime:cm-${table}`;

    let ws: WebSocket | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let ref = 0;
    let closed = false;

    const nextRef = () => String(++ref);

    const send = (msg: object) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
      }
    };

    const subscribe = () => {
      const joinRef = nextRef();
      send({
        topic: channelTopic,
        event: 'phx_join',
        payload: {
          config: {
            broadcast: { ack: false, self: false },
            presence: { key: '' },
            postgres_changes: [
              { event: 'INSERT', schema: 'public', table },
            ],
          },
          access_token: key,
        },
        ref: joinRef,
        join_ref: joinRef,
      });
    };

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(wsEndpoint);
      } catch {
        if (!closed) reconnectTimer = setTimeout(connect, 5_000);
        return;
      }

      ws.onopen = () => {
        setConnected(true);
        subscribe();
        heartbeatTimer = setInterval(() => {
          send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: nextRef() });
        }, 25_000);
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data as string) as {
            event: string;
            payload?: {
              data?: {
                eventType?: string;
                new?: Record<string, unknown>;
                commit_timestamp?: string;
              };
            };
          };

          if (
            msg.event === 'postgres_changes' &&
            msg.payload?.data?.eventType === 'INSERT' &&
            msg.payload.data.new
          ) {
            const rawRow = { ...msg.payload.data.new } as Record<string, unknown>;

            // Use the commit_timestamp for ordering when the row has no created_at
            if (!rawRow.created_at && msg.payload.data.commit_timestamp) {
              rawRow.created_at = msg.payload.data.commit_timestamp;
            }

            const normalized = normalizeRow(rawRow);
            if (normalized) {
              appendToMsgCache(normalized);
              queryClient.invalidateQueries({ queryKey: ['sessions'] });
              queryClient.invalidateQueries({ queryKey: ['analytics'] });
              queryClient.invalidateQueries({ queryKey: ['chart-data'] });
              queryClient.invalidateQueries({ queryKey: ['chat-history', normalized.session_id] });
              cbRef.current?.(normalized.session_id);
            }
          }
        } catch { /* ignore malformed messages */ }
      };

      ws.onclose = () => {
        setConnected(false);
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        if (!closed) reconnectTimer = setTimeout(connect, 3_000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      closed = true;
      setConnected(false);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, []); // run once — credentials come from localStorage

  return { connected };
}
