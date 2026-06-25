import { Hono } from "hono";
import { adminMiddleware, authMiddleware } from "../middleware/auth.ts";
import { getQueueOverview } from "../services/queue.ts";

const router = new Hono();

/**
 * 获取评测队列全局概览。
 * GET /api/v1/queue
 *
 * 权限：admin 限定。
 *
 * 设计决策说明（issue #64 §3.2）：
 * - 当前版本限制为 admin，原因：响应包含所有用户的 user_id、username、problem_id 等元信息，
 *   任意访问可被用于追踪其他用户的活跃时段与提交行为。
 * - 若 LMCC 比赛要求公示队列用于防作弊，应在本路由中移除 adminMiddleware 并仅返回脱敏后的字段
 *   （如隐藏 submitted_by / problem_title），或在 noj-ui 单独提供匿名版公开接口。
 */
router.get("/", authMiddleware, adminMiddleware, async (c) => {
  const overview = await getQueueOverview();
  return c.json(overview);
});

export default router;
