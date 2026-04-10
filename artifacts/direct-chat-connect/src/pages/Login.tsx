import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { verifyAdminCredentials, setAdminSession } from "@/lib/adminAuth";

const Login = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const navigate = useNavigate();

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      toast.error("Please enter your email and password");
      return;
    }
    setIsLoading(true);
    try {
      const isAdmin = await verifyAdminCredentials(email, password);
      if (isAdmin) {
        setAdminSession();
        toast.success("Welcome back! Loading dashboard...");
        setTimeout(() => { window.location.href = "/"; }, 500);
      } else {
        toast.error("Incorrect email or password. If you were invited, please use your invite link.");
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    const particles: { x: number; y: number; vx: number; vy: number; size: number; alpha: number; color: string }[] = [];
    const colors = ["#3b82f6", "#8b5cf6", "#06b6d4", "#6366f1"];
    for (let i = 0; i < 55; i++) {
      particles.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        size: Math.random() * 2 + 0.5,
        alpha: Math.random() * 0.5 + 0.1,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color + Math.floor(p.alpha * 255).toString(16).padStart(2, "0");
        ctx.fill();
      });

      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 120) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(99,102,241,${0.12 * (1 - dist / 120)})`;
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      }

      animId = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden p-4"
      style={{ background: "linear-gradient(135deg, #0a0e1a 0%, #0f172a 40%, #0d1b2e 70%, #090d1a 100%)" }}>

      <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />

      <div className="absolute inset-0 pointer-events-none" style={{
        background: "radial-gradient(ellipse 60% 50% at 20% 30%, rgba(99,102,241,0.12) 0%, transparent 70%), radial-gradient(ellipse 50% 40% at 80% 70%, rgba(6,182,212,0.10) 0%, transparent 65%)"
      }} />

      <div className="relative z-10 w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 mb-4">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center"
              style={{ background: "linear-gradient(135deg, #3b82f6, #8b5cf6)" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">
            Chat <span style={{ background: "linear-gradient(90deg, #3b82f6, #8b5cf6)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Monitor</span>
          </h1>
          <p className="mt-2 text-sm" style={{ color: "rgba(148,163,184,0.8)" }}>Sign in to access the dashboard</p>
        </div>

        <div className="rounded-2xl p-7" style={{
          background: "rgba(15,23,42,0.75)",
          backdropFilter: "blur(24px)",
          border: "1px solid rgba(99,102,241,0.18)",
          boxShadow: "0 0 0 1px rgba(255,255,255,0.04), 0 24px 64px rgba(0,0,0,0.5), 0 0 40px rgba(99,102,241,0.06)"
        }}>
          <form onSubmit={handleSignIn} className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-sm font-medium" style={{ color: "rgba(203,213,225,0.9)" }}>Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your email"
                required
                data-testid="input-email"
                className="h-11 text-white placeholder:text-slate-500 focus-visible:ring-1 focus-visible:ring-indigo-500"
                style={{
                  background: "rgba(30,41,59,0.8)",
                  border: "1px solid rgba(99,102,241,0.2)",
                  borderRadius: "10px",
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-sm font-medium" style={{ color: "rgba(203,213,225,0.9)" }}>Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
                data-testid="input-password"
                className="h-11 text-white placeholder:text-slate-500 focus-visible:ring-1 focus-visible:ring-indigo-500"
                style={{
                  background: "rgba(30,41,59,0.8)",
                  border: "1px solid rgba(99,102,241,0.2)",
                  borderRadius: "10px",
                }}
              />
            </div>
            <button
              type="submit"
              disabled={isLoading}
              data-testid="button-sign-in"
              className="w-full h-11 rounded-xl font-semibold text-white text-sm transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed mt-1"
              style={{
                background: isLoading
                  ? "rgba(99,102,241,0.5)"
                  : "linear-gradient(135deg, #3b82f6 0%, #6366f1 50%, #8b5cf6 100%)",
                boxShadow: isLoading ? "none" : "0 4px 20px rgba(99,102,241,0.35)",
              }}
            >
              {isLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Signing in…
                </span>
              ) : "Sign In"}
            </button>
          </form>
        </div>

        <p className="mt-5 text-center text-xs" style={{ color: "rgba(100,116,139,0.7)" }}>
          Powered by Chat Monitor
        </p>
      </div>
    </div>
  );
};

export default Login;
