/**
 * 管理端路由组合入口（barrel）。
 *
 * 提供（挂载前缀 /api/v1/admin，见 app.ts）：
 * - /identity/users、/identity/roles、/identity/permissions、/identity/blacklist
 * - /catalog/problems、/catalog/trainings
 * - /submissions、/contest/contests、/judge-images、
 *   /dashboard/stats、/settings、/audit-logs、/announcements、/llm/...
 *
 * 组级守卫：所有 admin 端点均需认证 + 管理员权限，在此统一挂载。
 * 例外：公告与 catalog 子域已抽至独立 router，使用各自的细粒度权限。
 * 此处必须跳过对应路径，否则组级通配 use 会先于独立 router 拦截请求。
 */
import { Hono } from "hono";
import type { AuthEnv } from "../identity/index.ts";
import { adminMiddleware, authMiddleware } from "../identity/index.ts";
import identityAdminRouter from "./routes/identity.ts";
import catalogAdminRouter from "./routes/catalog.ts";
import submissionAdminRouter from "./routes/submission.ts";
import queryAdminRouter from "./routes/query.ts";
import contestAdminRouter from "./routes/contest.ts";
import systemAdminRouter from "./routes/system.ts";
import communityAdminRouter from "./routes/community.ts";
import gatewayAdminRouter from "./routes/gateway.ts";

const router = new Hono<AuthEnv>();

const FINE_GRAINED_ADMIN_PREFIXES = [
  "/api/v1/admin/catalog",
  "/api/v1/admin/system/announcements",
  "/api/v1/admin/community",
] as const;

router.use("*", authMiddleware, async (c, next) => {
  if (
    FINE_GRAINED_ADMIN_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))
  ) {
    return next();
  }
  return await adminMiddleware(c, next);
});

router.route("/identity", identityAdminRouter);
router.route("/catalog", catalogAdminRouter);
router.route("/submission", submissionAdminRouter);
router.route("/query", queryAdminRouter);
router.route("/contest", contestAdminRouter);
router.route("/system", systemAdminRouter);
router.route("/community", communityAdminRouter);
router.route("/gateway", gatewayAdminRouter);

export default router;
