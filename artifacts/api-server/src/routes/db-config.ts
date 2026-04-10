/**
 * POST /api/db-config   — save the active DB connection (pushed from the dashboard)
 * GET  /api/db-config   — retrieve saved config (status only, keys masked)
 * DELETE /api/db-config — clear saved config
 */

import { Router, type Request, type Response } from "express";
import {
  getServerDbConfig,
  saveServerDbConfig,
  clearServerDbConfig,
  type ServerDbConfig,
} from "../lib/server-db-config";

const router = Router();

router.post("/db-config", (req: Request, res: Response) => {
  const body = req.body as Partial<ServerDbConfig>;
  if (!body.dbType) {
    return void res.status(400).json({ error: "dbType is required" });
  }
  saveServerDbConfig(body as ServerDbConfig);
  res.json({ ok: true });
});

router.get("/db-config", (_req: Request, res: Response) => {
  const cfg = getServerDbConfig();
  if (!cfg) return void res.json({ configured: false });
  res.json({
    configured: true,
    dbType: cfg.dbType,
    supabase_url: cfg.supabase_url ? cfg.supabase_url : undefined,
    host: cfg.host,
  });
});

router.delete("/db-config", (_req: Request, res: Response) => {
  clearServerDbConfig();
  res.json({ ok: true });
});

export default router;
