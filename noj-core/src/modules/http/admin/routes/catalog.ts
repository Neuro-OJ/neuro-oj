/**
 * Admin catalog 子域路由。
 *
 * 挂载前缀：/api/v1/admin/catalog（由 domains/admin/index.ts 以 /catalog 挂载）。
 *
 * 2026-11 精简：旧发布前预检 `/problems/:id/preflight` 与 `/trainings*` 题单管理端点
 * 前端零调用，已删除；预检由域内 `/:ref/publish-preflight` 承担，题单管理在
 * `/d/:slug/trainings`。这里只保留竞赛页选择器使用的全量题目列表。
 */
import { MAX_SAFE_PAGE } from "../../../../shared/http/pagination.ts";
import { Hono } from "hono";
import type { AuthEnv } from "../../../access/identity/middleware/auth.ts";
import { assertPermission } from "../../../access/identity/services/security/permissions.ts";
import { authMiddleware } from "../../../access/identity/middleware/auth.ts";
import { withActorContext } from "../../../platform/system/services/request-context.ts";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import { listAllProblems } from "../../../problems/services/problems/problems.ts";

const router = new Hono<AuthEnv>();

/**
 * 组级中间件：认证 + RequestContext 注入；权限在 handler 内校验。
 * 应用于本路由组全部路径。
 */
router.use("*", authMiddleware, (c, next) => {
  return withActorContext(c, () => next());
});

/**
 * 管理员获取全量题目列表（仅默认 Domain，含获授权私有题）。
 * GET /api/v1/admin/catalog/problems
 */
router.get("/problems", async (c) => {
  await assertPermission(c, "admin:full_access");
  if (c.req.query("type") !== undefined) {
    throw new BadRequestError("题库筛选已取消 P/U 分类");
  }
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);

  if (Number.isNaN(page) || Number.isNaN(limit)) {
    throw new BadRequestError("分页参数 page 和 limit 必须为数字");
  }
  // 超大 page 会让 OFFSET 超出 PG bigint（2026-09-21 修复）。
  if (page > MAX_SAFE_PAGE) {
    throw new BadRequestError("分页参数 page 超出允许范围");
  }

  const result = await listAllProblems({
    page: Math.max(1, page),
    limit: Math.min(100, Math.max(1, limit)),
    difficulty: c.req.query("difficulty") || undefined,
    tag: c.req.query("tag") || undefined,
    keyword: c.req.query("keyword") || undefined,
  });

  return c.json({
    data: result.items,
    total: result.total,
    page: result.page,
    limit: result.limit,
  });
});

export default router;
