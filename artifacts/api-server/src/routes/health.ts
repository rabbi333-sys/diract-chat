import { Router, type IRouter } from "express";
// ❌ এইটা remove করো
// import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  // ✅ সরাসরি object return করো
  res.json({ status: "ok" });
});

export default router;
