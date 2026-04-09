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

// Build a Supabase client from the stored external db connection
function getGuestSupabaseClient() {
  try {
    // Try legacy settings first (most reliable for guest sessions)
    const raw = localStorage.getItem('chat_monitor_db_settings');
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg?.supabase_url && cfg?.service_role_key) {
        return createClient(cfg.supabase_url, cfg.service_role_key, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
      }
    }
    // Fall back to new multi-connection system
    const connsRaw = localStorage.getItem('meta_db_connections');
    const activeId = localStorage.getItem('meta_db_active_id');
    if (connsRaw) {
      const conns = JSON.parse(connsRaw) as Array<{
        id: string; url?: string; anonKey?: string; serviceRoleKey?: string;
      }>;
      const active = conns.find(c => c.id === activeId) ?? conns[0];
      if (active?.url && (active.anonKey || active.serviceRoleKey)) {
        return createClient(active.url, active.serviceRoleKey ?? active.anonKey!, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
      }
    }
  } catch { /* ignore */ }
  return null;
}

// Validate a guest token against the team_invites table.
// Returns 'valid' | 'revoked' | 'unknown'
async function validateGuestToken(token: string): Promise<'valid' | 'revoked' | 'unknown'> {
  try {
    const client = getGuestSupabaseClient();
    if (!client) return 'unknown';
    const { data, error } = await client
      .from('team_invites')
      .select('status')
      .eq('token', token)
      .maybeSingle();
    if (error) return 'unknown';
    if (!data) return 'revoked'; // row deleted
    if (data.status === 'revoked') return 'revoked';
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
        const guest = getGuestSession();
        if (guest) {
          // Validate the token against the database to check if it's been revoked
          const validity = await validateGuestToken(guest.token);
          if (cancelled) return;

          if (validity === 'revoked') {
            // Token has been revoked by admin — wipe ALL local state and deny access
            clearGuestSession();
            try {
              localStorage.removeItem('chat_monitor_db_settings');
              localStorage.removeItem('chat_monitor_platform_connections');
              localStorage.removeItem('chat_monitor_n8n_settings');
              localStorage.removeItem('meta_db_connections');
              localStorage.removeItem('meta_db_active_id');
            } catch { /* ignore */ }
            setUser(null);
            setIsGuest(false);
            setIsAdmin(false);
            setPermissions([]);
            setNotAuthorized(true);
            return;
          }

          // Token is valid (or couldn't be validated — give benefit of doubt)
          setUser(null);
          setIsGuest(true);
          setIsAdmin(guest.role === 'admin');
          setPermissions(guest.permissions ?? []);
          setNotAuthorized(false);
          return;
        }

        // No auth and no guest session
        setUser(null);
        setIsGuest(false);
        setIsAdmin(false);
        setPermissions([]);
        setNotAuthorized(false);
      } catch {
        // supabase.auth failed (e.g. placeholder URL on first load) — still check guest session
        const guest = getGuestSession();
        if (guest) {
          // Even in catch, try to validate
          const validity = await validateGuestToken(guest.token).catch(() => 'unknown' as const);
          if (cancelled) return;
          if (validity === 'revoked') {
            clearGuestSession();
            try {
              localStorage.removeItem('chat_monitor_db_settings');
              localStorage.removeItem('chat_monitor_platform_connections');
              localStorage.removeItem('chat_monitor_n8n_settings');
              localStorage.removeItem('meta_db_connections');
              localStorage.removeItem('meta_db_active_id');
            } catch { /* ignore */ }
            setNotAuthorized(true);
            return;
          }
          setUser(null);
          setIsGuest(true);
          setIsAdmin(guest.role === 'admin');
          setPermissions(guest.permissions ?? []);
          setNotAuthorized(false);
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
