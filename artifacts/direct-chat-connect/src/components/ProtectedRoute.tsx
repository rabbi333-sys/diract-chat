import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { User } from "@supabase/supabase-js";
import { Navigate } from "react-router-dom";
import { hasActiveConnection } from "@/lib/db-config";
import { isGuestSessionActive } from "@/lib/guestSession";
import { hasMemberSetup, getMemberSession } from "@/lib/memberAuth";
import Login from "@/pages/Login";
import ConnectDB from "@/pages/ConnectDB";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [memberAuthed, setMemberAuthed] = useState(false);
  const dbConnected = hasActiveConnection();
  const memberSetup = hasMemberSetup();

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      // 1. Check external Supabase member session (email/password auth)
      if (memberSetup) {
        try {
          const session = await getMemberSession();
          if (!cancelled && session) {
            setMemberAuthed(true);
            setLoading(false);
            return;
          }
        } catch { /* ignore */ }
        // Member setup exists but no session → will redirect to /member-login
        if (!cancelled) setLoading(false);
        return;
      }

      if (!dbConnected) {
        if (!cancelled) setLoading(false);
        return;
      }

      // 2. Check main Supabase admin session
      const { data: { session } } = await supabase.auth.getSession();
      if (!cancelled) {
        setUser(session?.user ?? null);
        setLoading(false);
      }
    };

    init();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (!memberSetup) setUser(session?.user ?? null);
      }
    );

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [dbConnected, memberSetup]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
          <p className="mt-2 text-muted-foreground text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  // Member email/password session is active
  if (memberAuthed) {
    return <>{children}</>;
  }

  // Member setup exists but session expired/missing → member login
  if (memberSetup && !memberAuthed) {
    return <Navigate to="/member-login" replace />;
  }

  // Old-style guest session (backward compatibility for existing invited users)
  if (!user && isGuestSessionActive()) {
    return <>{children}</>;
  }

  // No DB connection → show ConnectDB inline (no separate route needed)
  if (!dbConnected) {
    return <ConnectDB />;
  }

  // Admin login
  if (!user) {
    return <Login />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;
