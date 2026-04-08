import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { User } from '@supabase/supabase-js';
import { getGuestSession } from '@/lib/guestSession';

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

  // Guest display name from email
  const guest = getGuestSession();
  const guestDisplayName = guest?.email?.split('@')[0] ?? 'Guest';
  const displayName = isGuest ? guestDisplayName : (user ? getDisplayName(user) : 'User');
  const initials = getInitials(displayName);

  return { user, isAdmin, permissions, notAuthorized, displayName, initials, loading, isGuest };
}
