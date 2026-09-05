import { getSetting } from "../services/system-settings.ts";
import { Hono } from "hono";
import announcements from "./announcements.ts";
import adminAnnouncements from "./admin-announcements.ts";
import adminAudit from "./admin-audit.ts";
import adminJudgeImages from "./admin-judge-images.ts";
import adminSettings from "./admin-settings.ts";

/** system 域公开路由，挂载到 `/api/v1`。 */
export const systemRouter = new Hono();
systemRouter.route("/announcements", announcements);
// 明确白名单，禁止将完整系统设置暴露给匿名访客。
systemRouter.get("/data-policy", (c) =>
  c.json({
    data: {
      contact: String(getSetting("data_policy_contact")?.value ?? ""),
      deployment: String(getSetting("data_policy_deployment")?.value ?? ""),
    },
  }));

/** system 域管理路由，挂载到 `/api/v1/admin`。 */
export const systemAdminRouter = new Hono();
systemAdminRouter.route("/announcements", adminAnnouncements);
systemAdminRouter.route("/", adminAudit);
systemAdminRouter.route("/", adminJudgeImages);
systemAdminRouter.route("/", adminSettings);
