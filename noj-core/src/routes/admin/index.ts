/**
 * 管理端路由组合入口（barrel）。
 *
 * 提供（挂载前缀 /api/v1/admin，见 app.ts）：
 * - /users、/problems、/submissions、/contests、/judge-images、
 *   /dashboard/stats、/settings、/blacklist、/audit-logs、/roles、/permissions
 *
 * 组级守卫：所有 admin 端点均需认证 + 管理员权限，在此统一挂载。
 * 例外：公告与题单管理端点已抽至独立 router，使用各自的细粒度权限。
 * 此处必须跳过对应路径，否则组级通配 use 会先于独立 router 拦截请求。
 */
import { Hono } from "hono";
import type { AuthEnv } from "../../middleware/auth.ts";
import { adminMiddleware, authMiddleware } from "../../middleware/auth.ts";
import adminUsers from "../../domains/identity/routes/admin-users.ts";
import adminProblems from "../../domains/catalog/routes/admin-problems.ts";
import adminSubmissions from "../../domains/submission/routes/admin-submissions.ts";
import adminContests from "../../domains/contest/routes/admin-contests.ts";
import adminJudgeImages from "../../domains/system/routes/admin-judge-images.ts";
import adminSettings from "../../domains/system/routes/admin-settings.ts";
import adminBlacklist from "../../domains/identity/routes/admin-blacklist.ts";
import adminRoles from "../../domains/identity/routes/admin-roles.ts";
import adminAudit from "../../domains/system/routes/admin-audit.ts";
import adminDashboard from "./admin-dashboard.ts";
import adminLlm from "./admin-llm.ts";

const router = new Hono<AuthEnv>();

const FINE_GRAINED_ADMIN_PREFIXES = [
  "/api/v1/admin/announcements",
  "/api/v1/admin/trainings",
] as const;

// 路由组级中间件：所有 admin 端点均需认证 + 管理员权限。
router.use("*", authMiddleware, async (c, next) => {
  if (
    FINE_GRAINED_ADMIN_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))
  ) {
    return next();
  }
  return await adminMiddleware(c, next);
});

// 按资源域挂载子路由（各子路由路径保持与旧 routes/admin.ts 完全一致）
router.route("/", adminUsers);
router.route("/", adminProblems);
router.route("/", adminSubmissions);
router.route("/", adminContests);
router.route("/", adminJudgeImages);
router.route("/", adminSettings);
router.route("/", adminBlacklist);
router.route("/", adminRoles);
router.route("/", adminAudit);
router.route("/", adminDashboard);
router.route("/", adminLlm);

export default router;
