import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

function getActiveConfig(): { url: string; key: string } | null {
  try {
    const connectionsRaw = localStorage.getItem('meta_db_connections');
    const connections: Array<{ id: string; dbType?: string; url: string; anonKey: string }> = connectionsRaw
      ? JSON.parse(connectionsRaw)
      : [];
    const activeId = localStorage.getItem('meta_db_active_id');
    const active = connections.find(c => c.id === activeId) || connections[0] || null;
    if (active?.url && active?.anonKey) {
      try { new URL(active.url); } catch { return null; }
      return { url: active.url, key: active.anonKey };
    }
  } catch {
    // ignore
  }

  const envUrl = import.meta.env.VITE_SUPABASE_URL;
  const envKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (envUrl && envKey) {
    try { new URL(envUrl); return { url: envUrl, key: envKey }; } catch { /* ignore */ }
  }

  return null;
}

function createAuthOptions() {
  return {
    auth: {
      storage: localStorage,
      persistSession: true,
      autoRefreshToken: true,
      storageKey: 'meta-automation-auth',
    },
  };
}

let _client: SupabaseClient<Database> | null = null;

function getClient(): SupabaseClient<Database> {
  if (_client) return _client;
  const config = getActiveConfig();
  if (config) {
    try {
      _client = createClient<Database>(config.url, config.key, createAuthOptions());
      return _client;
    } catch {
      // fall through to stub
    }
  }
  // No valid config yet — return a stub client that will fail gracefully on use.
  // The ConnectDB form will be shown before any real requests are made.
  _client = createClient<Database>(
    'https://xxxxxxxxxxxxxxxxxxxxxxxx.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwbGFjZWhvbGRlciJ9.placeholder',
    { auth: { storage: localStorage, persistSession: false, autoRefreshToken: false, storageKey: 'meta-automation-auth' } }
  );
  return _client;
}

export const supabase = new Proxy({} as SupabaseClient<Database>, {
  get(_target, prop) {
    return (getClient() as any)[prop];
  },
  apply(_target, thisArg, args) {
    return (getClient() as any)(...args);
  },
});

/** Call after saving a new connection to force the client to reinitialize. */
export function resetSupabaseClient() {
  _client = null;
}
