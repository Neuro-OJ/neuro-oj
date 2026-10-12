import { Hono } from "hono";
import {
  type AuthEnv,
  authMiddleware,
  checkPermission,
} from "./../../identity/index.ts";
import { getQueueOverview } from "../services/queue.ts";

const router = new Hono<AuthEnv>();

/**
 * 获取评测队列全局概览。
 * GET /api/v1/queue
 *
 * 权限：登录用户可访问。
 *
 * 设计决策（issue #64 §3.2 修订）：
 * - 最初限制为 admin，经评审后改为登录用户可访问，因为队列页面是公开可见的。
 * - 2026-09-28（审计 VULN-11）：登录可见保留，但**自测记录按查看者隔离**——
 *   普通用户只会看到自己的自测题目/得分，管理员才看全站。
 */
router.get("/", authMiddleware, async (c) => {
  const isAdmin = await checkPermission(c, "submission:read_all");
  // viewerUserId：非管理员的自测记录按用户隔离（审计 VULN-11）
  const overview = await getQueueOverview(isAdmin, c.var.userId);
  return c.json(overview);
});

export default router;
