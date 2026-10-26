import { Hono } from "hono";
import { optionalAuthMiddleware } from "../../../access/identity/middleware/auth.ts";
import { type OptionalAuthEnv } from "../../../../shared/http/hono-env.ts";
import { DEFAULT_DOMAIN_SLUG } from "../../../../shared/workspace/types.ts";
import { ensureDefaultWorkspace } from "../../../access/contracts/cross-module/workspace_services_domains.ts";
import { loadWorkspace } from "../../../access/contracts/cross-module/workspace_services_access.ts";
import {
  getDomainStats,
  PUBLIC_DEFAULT_QUERY_SCOPE,
} from "../services/domain-query.ts";
const stats = new Hono<OptionalAuthEnv>();
/** 旧公开统计入口固定默认域，当前源授权与比赛窗口在聚合前检查。 */
stats.get("/stats", optionalAuthMiddleware, async (c) => {
  await ensureDefaultWorkspace();
  await loadWorkspace(DEFAULT_DOMAIN_SLUG, c.var.userId ?? null);
  c.header("Cache-Control", "no-store");
  return c.json({ data: await getDomainStats(PUBLIC_DEFAULT_QUERY_SCOPE) });
});
export default stats;
