/**
 * POST /api/db-config   — save the active DB connection (pushed from the dashboard)
 * GET  /api/db-config   — retrieve saved config (status only, keys masked)
 * DELETE /api/db-config — clear saved config
 *
 * userId is derived from the verified JWT (req.userId set by authMiddleware).
 * Each user's config is stored independently — one user cannot overwrite another's.
 */

import { Router, type Request, type Response } from "express";
import {
  getServerDbConfig,
  saveServerDbConfig,
  clearServerDbConfig,
  type ServerDbConfig,
} from "../lib/server-db-config";
import { drainUserPools } from "../lib/connection-pool";

const router = Router();

router.post("/db-config", async (req: Request, res: Response) => {
  const userId = req.userId;
  if (!userId) {
    return void res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body as Partial<ServerDbConfig>;
  if (!body.dbType) {
    return void res.status(400).json({ error: "dbType is required" });
  }

  // Drain only the pools belonging to this user's old config before saving new one.
  // Serialization of drain + save is handled inside saveServerDbConfig via the mutex.
  await drainUserPools(userId);
  await saveServerDbConfig(userId, body as ServerDbConfig);
  res.json({ ok: true });
});

router.get("/db-config", (req: Request, res: Response) => {
  const userId = req.userId;
  if (!userId) {
    return void res.status(401).json({ error: "Unauthorized" });
  }

  const cfg = getServerDbConfig(userId);
  if (!cfg) return void res.json({ configured: false });
  res.json({
    configured: true,
    dbType: cfg.dbType,
    supabase_url: cfg.supabase_url ? cfg.supabase_url : undefined,
    host: cfg.host,
  });
});

router.delete("/db-config", async (req: Request, res: Response) => {
  const userId = req.userId;
  if (!userId) {
    return void res.status(401).json({ error: "Unauthorized" });
  }

  await drainUserPools(userId);
  clearServerDbConfig(userId);
  res.json({ ok: true });
});

export default router;
