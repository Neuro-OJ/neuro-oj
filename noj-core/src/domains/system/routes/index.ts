import { Hono } from "hono";
import announcements from "./announcements.ts";
import adminAnnouncements from "./admin-announcements.ts";
import adminAudit from "./admin-audit.ts";
import adminJudgeImages from "./admin-judge-images.ts";
import adminSettings from "./admin-settings.ts";

/** system 域公开路由，挂载到 `/api/v1`。 */
export const systemRouter = new Hono();
systemRouter.route("/announcements", announcements);

/** system 域管理路由，挂载到 `/api/v1/admin`。 */
export const systemAdminRouter = new Hono();
systemAdminRouter.route("/announcements", adminAnnouncements);
systemAdminRouter.route("/audit-logs", adminAudit);
systemAdminRouter.route("/judge-images", adminJudgeImages);
systemAdminRouter.route("/settings", adminSettings);
