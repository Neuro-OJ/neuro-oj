import { Hono } from "hono";
import rankings from "./rankings.ts";
import search from "./search.ts";
import stats from "./stats.ts";
import statsSse from "./sse.ts";
import adminDashboard from "./admin-dashboard.ts";

/** query 域公开路由，挂载到 `/api/v1`。 */
export const queryRouter = new Hono();
queryRouter.route("/rankings", rankings);
queryRouter.route("/search", search);
queryRouter.route("/", stats);
queryRouter.route("/", statsSse);

/** query 域管理路由，挂载到 `/api/v1/admin`。 */
export const queryAdminRouter = new Hono();
queryAdminRouter.route("/", adminDashboard);
