import { Hono } from "hono";
import contests from "./contests.ts";
import contestSse from "./sse.ts";

/** contest 域公开路由，挂载到 `/api/v1`。 */
export const contestRouter = new Hono();
contestRouter.route("/contests", contests);
contestRouter.route("/", contestSse);
