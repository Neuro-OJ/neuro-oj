import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "../../identity/index.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import {
  buildPaginationMeta,
  parsePagination,
} from "../../../shared/http/pagination.ts";
import { enforceUpgradeJobRateLimit } from "../../system/index.ts";
import {
  acceptDomainSubmissionJob,
  cancelDomainSubmissionJob,
  type DomainJobRequest,
  getDomainSubmissionJob,
  listDomainSubmissionJobItems,
} from "../services/versioning/domain-jobs.ts";
export const domainSubmissionJobsRouter = new Hono<AuthEnv>();
const prefix = "/domains/:slug/submission-jobs";
domainSubmissionJobsRouter.use("*", authMiddleware, async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
domainSubmissionJobsRouter.post(prefix, async (c) => {
  const body = await parseJsonBody<DomainJobRequest>(c);
  assertObjectBody(body);
  await enforceUpgradeJobRateLimit(c, c.var.userId);
  return c.json({
    data: await acceptDomainSubmissionJob(
      c.req.param("slug"),
      c.var.userId,
      body,
      c.req.header("idempotency-key")?.trim() ?? "",
    ),
  }, 202);
});
domainSubmissionJobsRouter.get(
  `${prefix}/:id`,
  async (c) =>
    c.json({
      data: await getDomainSubmissionJob(
        c.req.param("slug"),
        c.var.userId,
        c.req.param("id"),
      ),
    }),
);
domainSubmissionJobsRouter.get(`${prefix}/:id/items`, async (c) => {
  const { page, perPage } = parsePagination(c, { maxPerPage: 100 });
  const result = await listDomainSubmissionJobItems(
    c.req.param("slug"),
    c.var.userId,
    c.req.param("id"),
    { page, perPage },
  );
  return c.json({
    data: result.data,
    pagination: buildPaginationMeta(page, perPage, result.total),
  });
});
domainSubmissionJobsRouter.post(
  `${prefix}/:id/cancel`,
  async (c) =>
    c.json({
      data: await cancelDomainSubmissionJob(
        c.req.param("slug"),
        c.var.userId,
        c.req.param("id"),
      ),
    }),
);
