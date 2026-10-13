import { Hono } from "hono";
import {
  authMiddleware,
  type OptionalAuthEnv,
  optionalAuthMiddleware,
} from "../../identity/index.ts";
import {
  buildPaginationMeta,
  parsePagination,
} from "../../../shared/http/pagination.ts";
import {
  getDomainRankingRows,
  getDomainStats,
  loadDomainQueryScope,
} from "../services/domain-query.ts";

/** 显式域统计与榜单，应用组合根在查询隔离验收后统一挂载。 */
export const domainQueryRouter = new Hono<OptionalAuthEnv>();
domainQueryRouter.use("*", optionalAuthMiddleware, async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
domainQueryRouter.get(
  "/domains/:slug/stats",
  async (c) =>
    c.json({
      data: await getDomainStats(
        await loadDomainQueryScope(c.req.param("slug"), c.var.userId ?? null),
      ),
    }),
);
domainQueryRouter.get("/domains/:slug/rankings", async (c) => {
  const scope = await loadDomainQueryScope(
      c.req.param("slug"),
      c.var.userId ?? null,
    ),
    pagination = parsePagination(c, {
      defaultPerPage: 50,
      maxPerPage: 100,
      perPageField: "limit",
    });
  const result = await getDomainRankingRows(scope, {
    page: pagination.page,
    limit: pagination.perPage,
  });
  return c.json({
    data: result.data,
    pagination: buildPaginationMeta(
      pagination.page,
      pagination.perPage,
      result.total,
    ),
  });
});
domainQueryRouter.get(
  "/domains/:slug/rankings/me",
  authMiddleware,
  async (c) => {
    const result = await getDomainRankingRows(
      await loadDomainQueryScope(c.req.param("slug")!, c.var.userId!),
      { page: 1, limit: 1, userId: c.var.userId },
    );
    return c.json({ data: result.data[0] ?? null });
  },
);
