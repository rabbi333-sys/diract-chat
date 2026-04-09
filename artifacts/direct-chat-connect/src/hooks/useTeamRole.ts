import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { createClient } from '@supabase/supabase-js';
import type { User } from '@supabase/supabase-js';
import { getGuestSession, clearGuestSession } from '@/lib/guestSession';

export interface TeamRole {
  user: User | null;
  isAdmin: boolean;
  permissions: string[];
  notAuthorized: boolean;
  displayName: string;
  initials: string;
  loading: boolean;
  isGuest: boolean;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function getDisplayName(user: User): string {
  return (
    user.user_metadata?.display_name ||
    user.user_metadata?.full_name ||
    user.email?.split('@')[0] ||
    'User'
  );
}

// Keys to wipe when a guest's access is revoked
const REVOKE_KEYS = [
  'meta_guest_session',
  'chat_monitor_db_settings',
  'chat_monitor_platform_connections',
  'chat_monitor_n8n_settings',
  'meta_db_connections',
  'meta_db_active_id',
];

function wipeGuestAccess() {
  clearGuestSession();
  try {
    REVOKE_KEYS.forEach(k => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

// Derive the best Supabase URL + anon key to use for token validation.
// Priority: guest session itself → chat_monitor_db_settings → meta_db_connections
function getValidationCredentials(): { url: string; key: string } | null {
  try {
    // 1. Guest session carries the credentials (set during InviteAccept)
    const guestRaw = localStorage.getItem('meta_guest_session');
    if (guestRaw) {
      const gs = JSON.parse(guestRaw);
      if (gs?.dbUrl && gs?.dbAnonKey) {
        return { url: gs.dbUrl, key: gs.dbAnonKey };
      }
    }

    // 2. Legacy settings (anon key stored as 'anon_key')
    const legacyRaw = localStorage.getItem('chat_monitor_db_settings');
    if (legacyRaw) {
      const cfg = JSON.parse(legacyRaw);
      if (cfg?.supabase_url && cfg?.anon_key) {
        return { url: cfg.supabase_url, key: cfg.anon_key };
      }
      // Some old saves stored the key directly as service_role_key
      if (cfg?.supabase_url && cfg?.service_role_key) {
        return { url: cfg.supabase_url, key: cfg.service_role_key };
      }
    }

    // 3. New multi-connection system
    const connsRaw = localStorage.getItem('meta_db_connections');
    const activeId = localStorage.getItem('meta_db_active_id');
    if (connsRaw) {
      const conns = JSON.parse(connsRaw) as Array<{
        id: string; url?: string; anonKey?: string; serviceRoleKey?: string;
      }>;
      const active = conns.find(c => c.id === activeId) ?? conns[0];
      if (active?.url && (active.anonKey || active.serviceRoleKey)) {
        return { url: active.url, key: active.anonKey ?? active.serviceRoleKey! };
      }
    }
  } catch { /* ignore */ }
  return null;
}

// Validate a guest token using the get_invite_by_token RPC (works with anon key).
// Returns: 'valid' | 'revoked' | 'unknown'
async function validateGuestToken(token: string): Promise<'valid' | 'revoked' | 'unknown'> {
  try {
    const creds = getValidationCredentials();
    if (!creds) return 'unknown';

    const client = createClient(creds.url, creds.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await client.rpc('get_invite_by_token', { p_token: token });
    if (error) return 'unknown';

    // RPC returns empty → row was deleted
    const row = Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
    if (!row) return 'revoked';

    // Explicit revoke status
    if (row.status === 'revoked') return 'revoked';

    // Accepted or pending → still valid
    return 'valid';
  } catch {
    return 'unknown';
  }
}

export function useTeamRole(): TeamRole {
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [notAuthorized, setNotAuthorized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isGuest, setIsGuest] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const handleGuestSession = async () => {
      const guest = getGuestSession();
      if (!guest) return false; // not a guest

      const validity = await validateGuestToken(guest.token);
      if (cancelled) return true;

      if (validity === 'revoked') {
        wipeGuestAccess();
        setUser(null);
        setIsGuest(false);
        setIsAdmin(false);
        setPermissions([]);
        setNotAuthorized(true);
        return true;
      }

      // 'valid' or 'unknown' → grant access
      setUser(null);
      setIsGuest(true);
      setIsAdmin(guest.role === 'admin');
      setPermissions(guest.permissions ?? []);
      setNotAuthorized(false);
      return true;
    };

    const check = async () => {
      try {
        const { data: { user: authUser } } = await supabase.auth.getUser();
        if (cancelled) return;

        // ── Supabase authenticated user ──────────────────────────────────
        if (authUser) {
          setUser(authUser);
          setIsGuest(false);

          try {
            const { data: ownerRow, error: ownerError } = await supabase
              .from('app_owner')
              .select('user_id')
              .eq('user_id', authUser.id)
              .maybeSingle();

            if (cancelled) return;

            if (!ownerError && ownerRow) {
              setIsAdmin(true);
              setPermissions([]);
              setNotAuthorized(false);
              return;
            }

            const { data: invite, error: inviteError } = await supabase
              .from('team_invites')
              .select('role, permissions')
              .eq('accepted_user_id', authUser.id)
              .eq('status', 'accepted')
              .maybeSingle();

            if (cancelled) return;

            if (!inviteError && invite) {
              setIsAdmin(invite.role === 'admin');
              setPermissions(invite.permissions ?? []);
              setNotAuthorized(false);
            } else {
              setIsAdmin(false);
              setPermissions([]);
              setNotAuthorized(true);
            }
          } catch {
            setIsAdmin(false);
            setPermissions([]);
            setNotAuthorized(true);
          }
          return;
        }

        // ── No Supabase session — check for guest invite session ─────────
        const wasGuest = await handleGuestSession();
        if (wasGuest || cancelled) return;

        // No auth and no guest session
        setUser(null);
        setIsGuest(false);
        setIsAdmin(false);
        setPermissions([]);
        setNotAuthorized(false);
      } catch {
        // supabase.auth failed (e.g. placeholder URL on first load) — still check guest
        if (!cancelled) {
          await handleGuestSession();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    check();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      check();
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  // Guest display name: prefer explicit name, then email prefix
  const guest = getGuestSession();
  const guestDisplayName = guest?.name || guest?.email?.split('@')[0] || 'Guest';
  const displayName = isGuest ? guestDisplayName : (user ? getDisplayName(user) : 'User');
  const initials = getInitials(displayName);

  return { user, isAdmin, permissions, notAuthorized, displayName, initials, loading, isGuest };
}
