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
import type { AuthEnv } from "../identity/index.ts";
import { adminMiddleware, authMiddleware } from "../identity/index.ts";
import { identityAdminRouter } from "../identity/routes/index.ts";
import { catalogAdminRouter } from "../catalog/routes/index.ts";
import { submissionAdminRouter } from "../submission/routes/index.ts";
import { queryAdminRouter } from "../query/routes/index.ts";
import { contestAdminRouter } from "../contest/routes/index.ts";
import { systemAdminRouter } from "../system/routes/index.ts";
import { gatewayAdminRouter } from "../gateway/routes/index.ts";

const router = new Hono<AuthEnv>();

const FINE_GRAINED_ADMIN_PREFIXES = [
  "/api/v1/admin/announcements",
  "/api/v1/admin/trainings",
  "/api/v1/admin/problems/review",
] as const;

router.use("*", authMiddleware, async (c, next) => {
  if (
    FINE_GRAINED_ADMIN_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))
  ) {
    return next();
  }
  return await adminMiddleware(c, next);
});

router.route("/", identityAdminRouter);
router.route("/", catalogAdminRouter);
router.route("/", submissionAdminRouter);
router.route("/", queryAdminRouter);
router.route("/", contestAdminRouter);
router.route("/", systemAdminRouter);
router.route("/", gatewayAdminRouter);

export default router;
