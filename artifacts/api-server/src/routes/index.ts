import { Router, type IRouter } from "express";
import healthRouter from "./health";
import memberAuthRouter from "./member-auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(memberAuthRouter);

export default router;
