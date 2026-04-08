import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

function getActiveConfig(): { url: string; key: string } {
  try {
    const connectionsRaw = localStorage.getItem('meta_db_connections');
    const connections: Array<{ id: string; dbType?: string; url: string; anonKey: string }> = connectionsRaw
      ? JSON.parse(connectionsRaw)
      : [];
    const activeId = localStorage.getItem('meta_db_active_id');
    const active = connections.find(c => c.id === activeId) || connections[0] || null;
    // Only use stored credentials if this is a Supabase connection (has url + anonKey)
    if (active?.url && active?.anonKey) {
      return { url: active.url, key: active.anonKey };
    }
  } catch {
    // ignore
  }
  return {
    url: import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co',
    key: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'placeholder-key',
  };
}

const { url, key } = getActiveConfig();

export const supabase = createClient<Database>(url, key, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'meta-automation-auth',
  },
});
