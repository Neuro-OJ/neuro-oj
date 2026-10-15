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
  getDomainRecentSubmissions,
  getDomainStats,
  loadDomainQueryScope,
} from "../services/domain-query.ts";
import { getDomainSubmissionStats } from "../services/stats-cache.ts";

/** 显式域统计与榜单，只聚合当前授权范围内的使用域记录。 */
export const domainQueryRouter = new Hono<OptionalAuthEnv>();
for (
  const path of [
    "/domains/:slug/stats",
    "/domains/:slug/activity",
    "/domains/:slug/rankings",
    "/domains/:slug/rankings/*",
  ]
) {
  domainQueryRouter.use(path, optionalAuthMiddleware, async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
}
domainQueryRouter.get(
  "/domains/:slug/stats",
  async (c) =>
    c.json({
      data: await getDomainStats(
        await loadDomainQueryScope(c.req.param("slug"), c.var.userId ?? null),
      ),
    }),
);
domainQueryRouter.get("/domains/:slug/activity", async (c) => {
  const actor = c.var.userId ?? null;
  const scope = await loadDomainQueryScope(c.req.param("slug"), actor);
  const [recent, total, today] = await Promise.all([
    getDomainRecentSubmissions(scope, actor),
    getDomainSubmissionStats(scope),
    getDomainSubmissionStats(scope, true, actor ?? undefined),
  ]);
  return c.json({ data: { recent, total, today } });
});
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
