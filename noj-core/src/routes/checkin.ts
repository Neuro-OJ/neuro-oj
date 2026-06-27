import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.ts";
import { checkIn, getTodayCheckIn } from "../services/checkin.ts";

type Env = {
  Variables: {
    userId: string;
    userRole: string;
  };
};

const router = new Hono<Env>();

/**
 * 签到。
 * POST /api/v1/checkin
 */
router.post("/", authMiddleware, async (c) => {
  const userId = c.var.userId!;
  const result = await checkIn(userId);
  return c.json({ data: result });
});

/**
 * 获取今日签到状态。
 * GET /api/v1/checkin/today
 */
router.get("/today", authMiddleware, async (c) => {
  const userId = c.var.userId!;
  const result = await getTodayCheckIn(userId);
  return c.json({ data: result });
});

export default router;
