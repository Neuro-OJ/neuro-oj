/**
 * 管理端路由组合入口（barrel）。
 *
 * 提供（挂载前缀 /api/v1/admin，见 app.ts）：
 * - /users、/problems、/submissions、/contests、/judge-images、
 *   /dashboard/stats、/settings、/blacklist、/audit-logs、/roles、/permissions
 *
 * 组级守卫：所有 admin 端点均需认证 + 管理员权限，在此统一挂载。
 * 例外：公告管理端点（/announcements*）已抽至独立 router
 * （routes/admin-announcements.ts，细粒度权限 announcement:manage，
 * admin:full_access 通配放行或显式拥有该权限均可），此处对公告路径跳过
 * adminMiddleware——否则组级通配 use 会先行拦截细粒度权限持有者。
 */
import { Hono } from "hono";
import type { AuthEnv } from "../../middleware/auth.ts";
import { adminMiddleware, authMiddleware } from "../../middleware/auth.ts";
import adminUsers from "./admin-users.ts";
import adminProblems from "./admin-problems.ts";
import adminSubmissions from "./admin-submissions.ts";
import adminContests from "./admin-contests.ts";
import adminJudgeImages from "./admin-judge-images.ts";
import adminSettings from "./admin-settings.ts";
import adminBlacklist from "./admin-blacklist.ts";
import adminRoles from "./admin-roles.ts";
import adminAudit from "./admin-audit.ts";
import adminDashboard from "./admin-dashboard.ts";

const router = new Hono<AuthEnv>();

// 路由组级中间件：所有 admin 端点均需认证 + 管理员权限。
router.use("*", authMiddleware, async (c, next) => {
  if (c.req.path.startsWith("/api/v1/admin/announcements")) {
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

export default router;
