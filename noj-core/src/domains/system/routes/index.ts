import { getSetting } from "../services/system-settings.ts";
import { Hono } from "hono";
import announcements from "./announcements.ts";
import emailDelivery from "./email-delivery.ts";

/** system 域公开路由，挂载到 `/api/v1`。 */
export const systemRouter = new Hono();
systemRouter.route("/announcements", announcements);
systemRouter.route("/", emailDelivery);
// 明确白名单，禁止将完整系统设置暴露给匿名访客。
systemRouter.get("/data-policy", (c) =>
  c.json({
    data: {
      contact: String(getSetting("data_policy_contact")?.value ?? ""),
      deployment: String(getSetting("data_policy_deployment")?.value ?? ""),
    },
  }));
