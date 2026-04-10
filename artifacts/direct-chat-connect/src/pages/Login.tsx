import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

async function claimOwnershipIfFirst(): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('claim_owner_if_unclaimed');
    if (error) {
      console.warn('claim_owner_if_unclaimed error:', error.message);
    } else if (data === false) {
      console.info('Workspace already has an owner — no claim made.');
    }
  } catch (e) {
    console.warn('claim_owner_if_unclaimed threw:', e);
  }
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
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        toast.error("Error signing in: " + error.message);
      } else if (data.session) {
        await claimOwnershipIfFirst();
        navigate("/");
      }
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
      const { count, error: ownerCheckError } = await supabase
        .from('app_owner')
        .select('user_id', { count: 'exact', head: true });

      if (ownerCheckError) {
        console.warn('app_owner check failed:', ownerCheckError.message);
      }

      if (typeof count === 'number' && count > 0) {
        toast.error("This workspace already has an owner. Please use an invite link to join.");
        return;
      }

      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) {
        toast.error("Error signing up: " + error.message);
      } else if (data.session) {
        await claimOwnershipIfFirst();
        toast.success("Account created! You are now the Admin with full access.");
        navigate("/");
      } else {
        toast.info("Account created! Please check your email to verify, then sign in — you will be set as Admin automatically.");
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
