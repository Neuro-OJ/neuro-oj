/**
 * 管理端路由组合入口（barrel）。
 *
 * 提供（挂载前缀 /api/v1/admin，见 app.ts）：
 * - /users、/problems、/submissions、/contests、/judge-images、
 *   /dashboard/stats、/settings、/blacklist、/audit-logs、/roles、/permissions、
 *   /announcements、/trainings、/llm/...
 *
 * 组级守卫：所有 admin 端点均需认证 + 管理员权限，在此统一挂载。
 * 例外：公告与题单管理端点已抽至独立 router，使用各自的细粒度权限。
 * 此处必须跳过对应路径，否则组级通配 use 会先于独立 router 拦截请求。
 */
import { Hono } from "hono";
import type { AuthEnv } from "./../../domains/identity/index.ts";
import {
  adminMiddleware,
  authMiddleware,
} from "./../../domains/identity/index.ts";
import { identityAdminRouter } from "../../domains/identity/routes/index.ts";
import { catalogAdminRouter } from "../../domains/catalog/routes/index.ts";
import { submissionAdminRouter } from "../../domains/submission/routes/index.ts";
import { queryAdminRouter } from "../../domains/query/routes/index.ts";
import { contestAdminRouter } from "../../domains/contest/routes/index.ts";
import { systemAdminRouter } from "../../domains/system/routes/index.ts";
import { gatewayAdminRouter } from "../../domains/gateway/routes/index.ts";

const router = new Hono<AuthEnv>();

const FINE_GRAINED_ADMIN_PREFIXES = [
  "/api/v1/admin/announcements",
  "/api/v1/admin/trainings",
] as const;

/**
 * 管理端路由组级守卫中间件。
 *
 * 对所有 admin 端点（`*` 通配）统一执行认证 + 管理员权限校验：
 * - 先经 `authMiddleware` 完成 JWT 认证；
 * - 对公告（announcements）与题单（trainings）等细粒度权限路径直接放行，
 *   交由各自独立 router 处理；
 * - 其余路径经 `adminMiddleware` 校验管理员权限。
 *
 * 权限：需登录且具备管理员权限（细粒度前缀路径除外）。
 * 响应：无权限时由中间件抛出对应错误（401/403）。
 */
router.use("*", authMiddleware, async (c, next) => {
  if (
    FINE_GRAINED_ADMIN_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))
  ) {
    return next();
  }
  return await adminMiddleware(c, next);
});

// 按域挂载管理子路由（各域 router 内部路径保持与旧 routes/admin.ts 完全一致）
router.route("/", identityAdminRouter);
router.route("/", catalogAdminRouter);
router.route("/", submissionAdminRouter);
router.route("/", queryAdminRouter);
router.route("/", contestAdminRouter);
router.route("/", systemAdminRouter);
router.route("/", gatewayAdminRouter);

export default router;
