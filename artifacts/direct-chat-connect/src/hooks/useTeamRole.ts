import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { User } from '@supabase/supabase-js';
import { getGuestSession, clearGuestSession } from '@/lib/guestSession';
import { hasMemberSetup, getMemberUser, getMemberClient } from '@/lib/memberAuth';

export interface TeamRole {
  user: User | null;
  isAdmin: boolean;
  role: string;
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
  const [role, setRole] = useState('');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [notAuthorized, setNotAuthorized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isGuest, setIsGuest] = useState(false);
  const [displayName, setDisplayName] = useState('User');

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        // ── 1. External Supabase member session (email/password auth) ────────
        if (hasMemberSetup()) {
          const memberUser = await getMemberUser();
          if (!cancelled && memberUser) {
            const meta = memberUser.user_metadata ?? {};
            const role = (meta.role as string) ?? 'viewer';
            const perms: string[] = (meta.permissions as string[]) ?? [];
            const name = (meta.display_name as string) || memberUser.email?.split('@')[0] || 'Member';
            setUser(null);
            setIsGuest(true); // treats member like a restricted guest (respects permissions)
            setIsAdmin(role === 'admin' || role === 'sub-admin');
            setRole(role);
            setPermissions(perms);
            setNotAuthorized(false);
            setDisplayName(name);
            return;
          }
          // member setup but no session → not authorized (ProtectedRoute handles redirect)
          if (!cancelled) {
            setNotAuthorized(false); // Let ProtectedRoute handle the redirect
          }
          return;
        }

        // ── 2. Main Supabase admin session ───────────────────────────────────
        const { data: { user: authUser } } = await supabase.auth.getUser();
        if (cancelled) return;

        if (authUser) {
          setUser(authUser);
          setIsGuest(false);
          setDisplayName(getDisplayName(authUser));

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

        // ── 3. Old-style guest session (backward compat) ─────────────────────
        const guest = getGuestSession();
        if (guest) {
          setUser(null);
          setIsGuest(true);
          setIsAdmin(guest.role === 'admin');
          setPermissions(guest.permissions ?? []);
          setNotAuthorized(false);
          setDisplayName(guest.name || guest.email?.split('@')[0] || 'Guest');
          return;
        }

        // No auth
        setUser(null);
        setIsGuest(false);
        setIsAdmin(false);
        setPermissions([]);
        setNotAuthorized(false);
      } catch {
        // Auth call failed — fall back to guest session
        const guest = getGuestSession();
        if (guest && !cancelled) {
          setUser(null);
          setIsGuest(true);
          setIsAdmin(guest.role === 'admin');
          setPermissions(guest.permissions ?? []);
          setNotAuthorized(false);
          setDisplayName(guest.name || guest.email?.split('@')[0] || 'Guest');
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

  const initials = getInitials(displayName);

  return { user, isAdmin, role, permissions, notAuthorized, displayName, initials, loading, isGuest };
}
