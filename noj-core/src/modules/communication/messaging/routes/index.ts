import { Hono } from "hono";
import conversations from "./conversations.ts";

/** messaging 域公开路由，挂载到 `/api/v1`。 */
export const messagingRouter = new Hono();
messagingRouter.route("/conversations", conversations);
