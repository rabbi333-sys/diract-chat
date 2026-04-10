import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { isGuestSessionActive } from "@/lib/guestSession";
import { hasMemberSetup, getMemberSession } from "@/lib/memberAuth";
import { isAdminLoggedIn } from "@/lib/adminAuth";
import Login from "@/pages/Login";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const [loading, setLoading] = useState(true);
  const [memberAuthed, setMemberAuthed] = useState(false);
  const memberSetup = hasMemberSetup();

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      if (memberSetup) {
        try {
          const session = await getMemberSession();
          if (!cancelled && session) {
            setMemberAuthed(true);
            setLoading(false);
            return;
          }
        } catch { /* ignore */ }
        if (!cancelled) setLoading(false);
        return;
      }
      if (!cancelled) setLoading(false);
    };

    init();
    return () => { cancelled = true; };
  }, [memberSetup]);

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

  // Member (invited user) session active
  if (memberAuthed) return <>{children}</>;

  // Member setup exists but session expired → member login
  if (memberSetup && !memberAuthed) return <Navigate to="/member-login" replace />;

  // Old-style guest session (backward compat for existing invited users)
  if (isGuestSessionActive()) return <>{children}</>;

  // Hard-coded admin session
  if (isAdminLoggedIn()) return <>{children}</>;

  // No session → show login
  return <Login />;
};

export default ProtectedRoute;
