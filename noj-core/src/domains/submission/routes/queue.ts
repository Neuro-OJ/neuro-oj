import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "../../identity/index.ts";
import { getQueueOverview } from "../services/queue.ts";
import {
  assertActiveInstanceAccount,
  getUserPermissions,
} from "../../identity/index.ts";
import {
  DEFAULT_DOMAIN_SLUG,
  ensureDefaultWorkspace,
  loadWorkspace,
} from "../../workspace/index.ts";

const router = new Hono<AuthEnv>();
/** 新客户端显式指定域，实例概览不依赖用户能否进入默认域。 */
export const domainQueueRouter = new Hono<AuthEnv>();
domainQueueRouter.get("/domains/:slug/queue", authMiddleware, async (c) => {
  const access = await loadWorkspace(c.req.param("slug")!, c.var.userId);
  c.header("Cache-Control", "no-store");
  return c.json(
    await getQueueOverview(access.platformAdmin, c.var.userId, {
      domainId: access.domain.id,
      member: !!access.membership || access.platformAdmin,
    }),
  );
});
domainQueueRouter.get("/instance/queue", authMiddleware, async (c) => {
  await assertActiveInstanceAccount(c.var.userId);
  const isAdmin = (await getUserPermissions(c.var.userId)).has(
    "admin:full_access",
  );
  c.header("Cache-Control", "no-store");
  return c.json(
    await getQueueOverview(isAdmin, c.var.userId, {
      domainId: "",
      member: false,
      instance: true,
      viewerId: c.var.userId,
      platformAdmin: isAdmin,
    }),
  );
});

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
  await ensureDefaultWorkspace();
  const workspace = await loadWorkspace(DEFAULT_DOMAIN_SLUG, c.var.userId);
  const isAdmin = workspace.platformAdmin;
  // viewerUserId：非管理员的自测记录按用户隔离（审计 VULN-11）
  const overview = await getQueueOverview(isAdmin, c.var.userId, {
    domainId: workspace.domain.id,
    member: !!workspace.membership || workspace.platformAdmin,
  });
  c.header("Cache-Control", "no-store");
  return c.json(overview);
});

export default router;
