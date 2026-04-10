import { Router, type IRouter } from "express";
import healthRouter from "./health";
import memberAuthRouter from "./member-auth";
import aiStatusRouter from "./ai-status";
import setupTablesRouter from "./setup-tables";

const router: IRouter = Router();

router.use(healthRouter);
router.use(memberAuthRouter);
router.use(aiStatusRouter);
router.use(setupTablesRouter);

export default router;
