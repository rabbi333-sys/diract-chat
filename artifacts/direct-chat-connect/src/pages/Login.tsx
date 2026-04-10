import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

const EMAIL_NOTICE_KEY = "meta_email_notice_dismissed";

/**
 * Attempts to claim app ownership for the currently authenticated user.
 * Returns true  — ownership was just claimed (this user is now Admin)
 * Returns false — ownership was already taken (workspace has an owner)
 * Throws        — RPC call failed (treat as an error, do not claim success)
 */
async function tryClaimOwnership(): Promise<boolean> {
  const { data, error } = await supabase.rpc('claim_owner_if_unclaimed');
  if (error) throw new Error(error.message);
  return data === true;
}

const Login = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [noticeDismissed, setNoticeDismissed] = useState(() => localStorage.getItem(EMAIL_NOTICE_KEY) === "1");
  const navigate = useNavigate();

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        toast.error("Error signing in: " + error.message);
        return;
      }
      // Edge-case: first user verified email, then signed in.
      // If app_owner is still empty, claim it now (idempotent — no harm if already owned).
      try {
        await tryClaimOwnership();
      } catch {
        // Non-fatal on sign-in path — user is still authenticated.
      }
      navigate("/");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      toast.error("Network error: " + (msg || "Could not reach Supabase."));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignUp = async () => {
    if (!email || !password) { toast.error("Please enter email and password"); return; }
    if (password.length < 6) { toast.error("Password must be at least 6 characters"); return; }
    setIsLoading(true);
    try {
      // ── Check whether a workspace owner already exists ────────────────────
      const { count, error: ownerCheckError } = await supabase
        .from('app_owner')
        .select('user_id', { count: 'exact', head: true });

      if (ownerCheckError) {
        // Fail-closed: if we cannot confirm the workspace is unclaimed, block signup.
        toast.error("Unable to verify workspace status. Please try again.");
        return;
      }

      if (typeof count === 'number' && count > 0) {
        toast.error("This workspace already has an owner. Please use an invite link to join.");
        return;
      }

      // ── Proceed with signup ───────────────────────────────────────────────
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) {
        toast.error("Error signing up: " + error.message);
        return;
      }

      if (data.session) {
        // Email confirmation disabled — user is logged in immediately. Claim ownership now.
        try {
          const claimed = await tryClaimOwnership();
          if (claimed) {
            toast.success("Account created! You are now the Admin with full access.");
            navigate("/");
          } else {
            // Race condition: another user claimed ownership between our check and this claim.
            await supabase.auth.signOut();
            toast.error("Another admin has already claimed this workspace. Please use an invite link to join.");
          }
        } catch (rpcErr) {
          // RPC failed — sign out to leave the user in a clean state.
          await supabase.auth.signOut();
          const msg = rpcErr instanceof Error ? rpcErr.message : String(rpcErr);
          toast.error("Account created but admin assignment failed: " + msg + ". Please contact support.");
        }
      } else {
        // Email confirmation is still enabled in Supabase settings.
        // Ownership will be claimed when the user verifies their email and signs in.
        toast.info("Account created! Please check your email to verify. You will be set as Admin automatically when you sign in.");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      toast.error("Network error: " + (msg || "Could not reach Supabase."));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md flex flex-col gap-4">
        {/* Email confirmation notice */}
        {!noticeDismissed && (
          <div className="rounded-xl border border-amber-200/70 bg-amber-50 p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <p className="text-xs font-bold text-amber-800 mb-1">Disable Email Confirmation for Instant Sign-Up</p>
                <p className="text-[10.5px] text-amber-700/80 leading-relaxed">
                  Go to <strong>Supabase → Authentication → Providers → Email</strong> and turn off <strong>"Confirm email"</strong> so new admins can sign up without email verification.
                </p>
              </div>
              <button
                onClick={() => { setNoticeDismissed(true); localStorage.setItem(EMAIL_NOTICE_KEY, "1"); }}
                className="flex-shrink-0 text-amber-500 hover:text-amber-700 transition-colors p-0.5"
                title="Dismiss"
                data-testid="button-dismiss-notice-login"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
        )}

        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-bold">
              Meta <span className="text-primary">Automation</span>
            </CardTitle>
            <CardDescription>Sign in to access the dashboard</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSignIn} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter your email"
                  required
                  data-testid="input-email"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                  data-testid="input-password"
                />
              </div>
              <div className="space-y-2">
                <Button type="submit" className="w-full" disabled={isLoading} data-testid="button-sign-in">
                  {isLoading ? "Please wait..." : "Sign In"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={handleSignUp}
                  disabled={isLoading}
                  data-testid="button-sign-up"
                >
                  {isLoading ? "Please wait..." : "Sign Up"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Login;
