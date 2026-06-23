import { Hono } from "hono";
import { getQueueOverview } from "../services/queue.ts";

const router = new Hono();

/**
 * 获取评测队列全局概览。
 * GET /api/v1/queue
 * 无需认证（面向 guest + user 开放）。
 */
router.get("/", async (c) => {
  const overview = await getQueueOverview();
  return c.json(overview);
});

export default router;
