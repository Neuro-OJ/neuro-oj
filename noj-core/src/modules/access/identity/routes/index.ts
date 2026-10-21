import { Hono } from "hono";
import auth from "./auth.ts";
import users from "./users.ts";
import checkin from "./checkin.ts";

/** identity 域公开路由，挂载到 `/api/v1`。 */
export const identityRouter = new Hono();
identityRouter.route("/auth", auth);
identityRouter.route("/users", users);
identityRouter.route("/checkin", checkin);
