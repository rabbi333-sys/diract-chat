import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { User } from '@supabase/supabase-js';

export interface TeamRole {
  user: User | null;
  isAdmin: boolean;
  permissions: string[];
  notAuthorized: boolean;
  displayName: string;
  initials: string;
  loading: boolean;
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

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const { data: { user: authUser } } = await supabase.auth.getUser();
        if (cancelled) return;

        if (!authUser) {
          setUser(null);
          setLoading(false);
          return;
        }

        setUser(authUser);

        try {
          // Step 1: Read-only check — is this user the pre-configured dashboard owner?
          // Ownership is set externally (Supabase SQL editor or admin script), never claimed
          // automatically by the client at runtime.
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

          // Step 2: Not the owner — look for an accepted invite
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
            // No owner record AND no accepted invite → not authorized
            setIsAdmin(false);
            setPermissions([]);
            setNotAuthorized(true);
          }
        } catch {
          // Any unexpected error (network, missing table, etc.) → deny access.
          // Never grant admin on an exception — always fail closed.
          setIsAdmin(false);
          setPermissions([]);
          setNotAuthorized(true);
        }
      } catch {
        // ignore auth errors
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

  const displayName = user ? getDisplayName(user) : 'User';
  const initials = getInitials(displayName);

  return { user, isAdmin, permissions, notAuthorized, displayName, initials, loading };
}
