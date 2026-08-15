import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.ts";
import { getQueueOverview } from "../services/queue.ts";

const router = new Hono();

/**
 * 获取评测队列全局概览。
 * GET /api/v1/queue
 *
 * 权限：登录用户可访问。
 *
 * 设计决策（issue #64 §3.2 修订）：
 * - 最初限制为 admin，经评审后改为登录用户可访问，因为队列页面是公开可见的。
 *   若 LMCC 比赛要求更严格的队列可见性，可在此路由中增加脱敏逻辑。
 */
router.get("/", authMiddleware, async (c) => {
  const overview = await getQueueOverview();
  return c.json(overview);
});

export default router;
