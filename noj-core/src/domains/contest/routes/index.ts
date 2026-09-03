import { Hono } from "hono";
import contests from "./contests.ts";
import contestSse from "./sse.ts";
import adminContests from "./admin-contests.ts";

/** contest 域公开路由，挂载到 `/api/v1`。 */
export const contestRouter = new Hono();
contestRouter.route("/contests", contests);
contestRouter.route("/", contestSse);

/** contest 域管理路由，挂载到 `/api/v1/admin`。 */
export const contestAdminRouter = new Hono();
contestAdminRouter.route("/contests", adminContests);
