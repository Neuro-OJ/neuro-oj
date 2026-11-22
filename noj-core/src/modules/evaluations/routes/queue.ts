import { Hono } from "hono";
import { authMiddleware } from "../../access/identity/middleware/auth.ts";
import { type AuthEnv } from "../../../shared/http/hono-env.ts";
import { getQueueOverview } from "../services/queue.ts";
import { assertActiveInstanceAccount } from "../../access/contracts/cross-module/identity_services_security_account-access.ts";
import { getUserPermissions } from "../../access/contracts/cross-module/identity_services_security_permissions.ts";
import { loadWorkspace } from "../../access/contracts/cross-module/workspace_services_access.ts";

const router = new Hono<AuthEnv>();
/** 新客户端显式指定域，实例概览不依赖用户能否进入默认域。 */
export const domainQueueRouter = new Hono<AuthEnv>();
domainQueueRouter.get("/domains/:slug/queue", authMiddleware, async (c) => {
  const access = await loadWorkspace(c.req.param("slug")!, c.var.userId);
  c.header("Cache-Control", "no-store");
  return c.json(
    await getQueueOverview(access.platformAdmin, c.var.userId, {
      domainId: access.domain.id,
      member: !!access.membership || access.platformAdmin,
    }),
  );
});
domainQueueRouter.get("/instance/queue", authMiddleware, async (c) => {
  await assertActiveInstanceAccount(c.var.userId);
  const isAdmin = (await getUserPermissions(c.var.userId)).has(
    "admin:full_access",
  );
  c.header("Cache-Control", "no-store");
  return c.json(
    await getQueueOverview(isAdmin, c.var.userId, {
      domainId: "",
      member: false,
      instance: true,
      viewerId: c.var.userId,
      platformAdmin: isAdmin,
    }),
  );
});

export default router;
