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

// ─── Always-public routes ─────────────────────────────────────────────────────
// Health check is mounted before the auth middleware — always reachable.
router.use(healthRouter);

// ─── Authentication middleware ────────────────────────────────────────────────
// All routes below require a valid Supabase JWT in Authorization: Bearer <token>.
// The following paths are explicitly excluded:
//
//   /webhook/events      — n8n/external webhooks authenticate with X-Webhook-Secret,
//                          not a Supabase JWT. Adding JWT auth here would break all
//                          webhook integrations.
//
//   /realtime/stream     — EventSource (SSE) cannot send custom request headers
//                          (browser limitation). This endpoint is secured indirectly:
//                          clients must first POST /api/realtime/init WITH a valid JWT
//                          to obtain a single-use 60-second token; only that token can
//                          open the SSE stream. No JWT → no token → no stream.
//
//   /member-auth/token   — Invited team members look up their invite via an email link.
//                          They do not have a Supabase session at this point and cannot
//                          obtain a JWT. The invite token itself is the authenticator.
//
//   /member-auth/submit  — Same flow: the invited person submits their name/email/password.
//                          Still pre-session. The pending invite token validates access.
//
//   /member-auth/login   — Team members log in using email/password stored in the invite
//                          record. They obtain a session from this call, so they cannot
//                          present a JWT before calling it.

const PUBLIC_PATHS = new Set([
  "/webhook/events",
  "/realtime/stream",
  "/member-auth/token",
  "/member-auth/submit",
  "/member-auth/login",
]);

router.use((req: Request, res: Response, next: NextFunction): void => {
  if (PUBLIC_PATHS.has(req.path)) return void next();
  authMiddleware(req, res, next);
});

// ─── Protected routes ─────────────────────────────────────────────────────────
router.use(memberAuthRouter);
router.use(aiStatusRouter);
router.use(setupTablesRouter);
router.use(sessionsRouter);
router.use(dbConfigRouter);
router.use(realtimeRouter);

export default router;
