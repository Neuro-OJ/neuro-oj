import { Hono } from "hono";
import problems from "./problems.ts";

/** catalog 域公开路由，挂载到 `/api/v1`。 */
export const catalogRouter = new Hono();
catalogRouter.route("/problems", problems);
