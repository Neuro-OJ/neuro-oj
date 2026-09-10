/**
 * 管理员观测路由。
 *
 * 由 domains/admin 门面挂载到 /api/v1/admin/dashboard 下，复用 RBAC 守卫。
 */

import { Hono } from "hono";
import type { ObservabilityRegistry } from "../../../shared/observability/contracts.ts";
import { getObservabilitySnapshot } from "../services/snapshot.ts";

export function createObservabilityAdminRouter(
  registry: ObservabilityRegistry,
): Hono {
  const router = new Hono();
  router.get("/observability", async (c) => {
    const snapshot = await getObservabilitySnapshot(registry);
    return c.json({ data: snapshot });
  });
  return router;
}
