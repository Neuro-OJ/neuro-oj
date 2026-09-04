import { Hono } from "hono";
import type { AuthEnv } from "./../../identity/index.ts";
import { getDashboardStats } from "../services/dashboard.ts";
import { getObservabilitySnapshot } from "../../system/services/observability.ts";

/**
 * 管理端仪表盘路由（挂载前缀 /api/v1/admin，见 admin/index.ts）。
 *
 * 提供：
 * - GET /dashboard/stats 统计数据
 */
const router = new Hono<AuthEnv>();

/**
 * 仪表盘统计数据。
 * GET /api/v1/admin/dashboard/stats
 */
router.get("/dashboard/stats", async (c) => {
  const stats = await getDashboardStats();
  return c.json({ data: stats });
});

router.get("/dashboard/observability", async (c) => {
  const snapshot = await getObservabilitySnapshot();
  return c.json({ data: snapshot });
});

export default router;
