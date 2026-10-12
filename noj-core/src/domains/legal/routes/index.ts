/**
 * legal 域路由聚合。
 *
 * 挂载到 `/api/v1`（见 app.ts），各子路由自带相对前缀。
 */
import { Hono } from "hono";
import documents from "./documents.ts";
import consent from "./consent.ts";
import dataRequests from "./data-requests.ts";

/** legal 域公开路由。 */
export const legalRouter = new Hono();
legalRouter.route("/legal", documents);
legalRouter.route("/legal", consent);
legalRouter.route("/legal", dataRequests);
