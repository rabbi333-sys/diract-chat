import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

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
      <Card className="w-full max-w-md">
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
  );
};

export default Login;
