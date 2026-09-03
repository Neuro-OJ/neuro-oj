import { Hono } from "hono";
import submissions from "./submissions.ts";
import queue from "./queue.ts";
import selfTests from "./self-tests.ts";
import sse from "./sse.ts";
import adminSubmissions from "./admin-submissions.ts";

/** submission 域公开路由，挂载到 `/api/v1`。 */
export const submissionRouter = new Hono();
submissionRouter.route("/submissions", submissions);
submissionRouter.route("/queue", queue);
submissionRouter.route("/", selfTests);
submissionRouter.route("/", sse);

/** submission 域管理路由，挂载到 `/api/v1/admin`。 */
export const submissionAdminRouter = new Hono();
submissionAdminRouter.route("/submissions", adminSubmissions);
