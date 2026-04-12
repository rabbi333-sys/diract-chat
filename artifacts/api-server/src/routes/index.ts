import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import healthRouter from "./health";
import memberAuthRouter from "./member-auth";
import aiStatusRouter from "./ai-status";
import setupTablesRouter from "./setup-tables";
import sessionsRouter from "./sessions";
import dbConfigRouter from "./db-config";
import realtimeRouter from "./realtime";
import { authMiddleware } from "../lib/auth-middleware.js";

const router: IRouter = Router();

// ─── Always-public routes ────────────────────────────────────────────────────
// Health check is mounted before the auth middleware so it's always reachable.
router.use(healthRouter);

// ─── Authentication middleware ────────────────────────────────────────────────
// Paths listed here bypass JWT verification:
//   /webhook/events    — n8n/external webhooks authenticate with X-Webhook-Secret
//   /member-auth/token — invited team members look up their invite (no session yet)
//   /member-auth/submit — invited team members submit their info (no session yet)
//   /member-auth/login  — team member login (no Supabase session yet)

const PUBLIC_PATHS = new Set([
  "/webhook/events",
  "/member-auth/token",
  "/member-auth/submit",
  "/member-auth/login",
]);

router.use((req: Request, res: Response, next: NextFunction): void => {
  if (PUBLIC_PATHS.has(req.path)) return void next();
  authMiddleware(req, res, next);
});

// ─── Protected routes ────────────────────────────────────────────────────────
router.use(memberAuthRouter);
router.use(aiStatusRouter);
router.use(setupTablesRouter);
router.use(sessionsRouter);
router.use(dbConfigRouter);
router.use(realtimeRouter);

export default router;
