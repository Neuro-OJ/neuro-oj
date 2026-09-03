import { Hono } from "hono";
import adminLlm from "./admin-llm.ts";

/** gateway 域管理路由，挂载到 `/api/v1/admin`。 */
export const gatewayAdminRouter = new Hono();
gatewayAdminRouter.route("/", adminLlm);
