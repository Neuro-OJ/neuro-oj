/**
 * legal 功能路由聚合。
 *
 * 挂载到 `/api/v1`（见 create-app.ts 的功能清单挂载）。各子路由在文件内用
 * 完整路径声明（原 `legalRouter.route("/legal", ...)` 的前缀已展开）。
 */
import { Hono } from "hono";
import { authMiddleware } from "../../modules/access/index.ts";
import { type AuthEnv } from "../../shared/http/hono-env.ts";
import consentRoutes from "./consent-routes.ts";
import dataRequestsRoutes from "./data-requests-routes.ts";
import documentsRoutes from "./documents-routes.ts";
import adminRoutes from "./admin-routes.ts";

/** legal 域路由（公开 + 用户 + `/admin/legal/...`）。 */
export const legalRouter = new Hono<AuthEnv>();
legalRouter.route("/", documentsRoutes);
legalRouter.route("/", consentRoutes);
legalRouter.route("/", dataRequestsRoutes);
legalRouter.use("/admin/legal/*", authMiddleware);
// `/admin/legal/...` 原由 admin 聚合的 `authMiddleware` 保护，迁出后显式挂载；
// 细粒度 `legal:manage` 权限检查保持在 admin-routes.ts 的处理器内。
legalRouter.route("/", adminRoutes);
