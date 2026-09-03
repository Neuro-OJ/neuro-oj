import { Hono } from "hono";
import auth from "./auth.ts";
import users from "./users.ts";
import checkin from "./checkin.ts";
import adminUsers from "./admin-users.ts";
import adminRoles from "./admin-roles.ts";
import adminBlacklist from "./admin-blacklist.ts";

/** identity 域公开路由，挂载到 `/api/v1`。 */
export const identityRouter = new Hono();
identityRouter.route("/auth", auth);
identityRouter.route("/users", users);
identityRouter.route("/checkin", checkin);

/** identity 域管理路由，挂载到 `/api/v1/admin`。 */
export const identityAdminRouter = new Hono();
identityAdminRouter.route("/users", adminUsers);
identityAdminRouter.route("/roles", adminRoles);
identityAdminRouter.route("/blacklist", adminBlacklist);
