import { Router, type IRouter } from "express";
import healthRouter from "./health";
import memberAuthRouter from "./member-auth";
import aiStatusRouter from "./ai-status";
import setupTablesRouter from "./setup-tables";
import sessionsRouter from "./sessions";
import dbConfigRouter from "./db-config";
import realtimeRouter from "./realtime";

const router: IRouter = Router();

router.use(healthRouter);
router.use(memberAuthRouter);
router.use(aiStatusRouter);
router.use(setupTablesRouter);
router.use(sessionsRouter);
router.use(dbConfigRouter);
router.use(realtimeRouter);

export default router;
