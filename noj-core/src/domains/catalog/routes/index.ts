import { Hono } from "hono";
import tags from "./tags.ts";
import problems from "./problems.ts";
import trainings from "./trainings.ts";
import adminProblems from "./admin-problems.ts";
import adminTrainings from "./admin-trainings.ts";

/** catalog 域公开路由，挂载到 `/api/v1`。 */
export const catalogRouter = new Hono();
catalogRouter.route("/tags", tags);
catalogRouter.route("/problems", problems);
catalogRouter.route("/trainings", trainings);

/** catalog 域管理路由，挂载到 `/api/v1/admin`。 */
export const catalogAdminRouter = new Hono();
catalogAdminRouter.route("/problems", adminProblems);
catalogAdminRouter.route("/trainings", adminTrainings);
