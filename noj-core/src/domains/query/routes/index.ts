import { Hono } from "hono";
import rankings from "./rankings.ts";
import stats from "./stats.ts";
import statsSse from "./sse.ts";

/** query 域公开路由，挂载到 `/api/v1`。 */
export const queryRouter = new Hono();
queryRouter.route("/rankings", rankings);
queryRouter.route("/", stats);
queryRouter.route("/", statsSse);
