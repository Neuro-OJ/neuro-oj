import { Hono } from "hono";
import submissions from "./submissions.ts";
import queue from "./queue.ts";
import selfTests from "./self-tests.ts";

/** submission 域公开路由，挂载到 `/api/v1`。 */
export const submissionRouter = new Hono();
submissionRouter.route("/submissions", submissions);
submissionRouter.route("/queue", queue);
submissionRouter.route("/", selfTests);
