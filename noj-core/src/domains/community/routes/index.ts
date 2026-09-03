import { Hono } from "hono";
import community from "./community.ts";
import communityAdmin from "./community-admin.ts";
import communitySse from "./sse.ts";

/** community 域公开路由，挂载到 `/api/v1`。 */
export const communityRouter = new Hono();
communityRouter.route("/community", community);
communityRouter.route("/community", communityAdmin);
communityRouter.route("/", communitySse);
