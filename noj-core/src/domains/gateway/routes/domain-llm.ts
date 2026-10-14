import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "../../identity/index.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  addDomainLlmProvider,
  editDomainLlmProvider,
  readDomainLlmModelAliases,
  readDomainLlmProviders,
  readDomainLlmQuotas,
  readDomainLlmSettings,
  readDomainLlmUsage,
  removeDomainLlmModelAlias,
  saveDomainLlmModelAlias,
  saveDomainLlmQuota,
  saveDomainLlmSettings,
  testDomainLlmProvider,
} from "../services/domain-management.ts";
import {
  type LlmProviderInput,
  type LlmQuotaInput,
  parseLlmRevision,
} from "../services/llm.ts";
import type { LlmModelAliasInput } from "../services/llm-model-aliases.ts";

/** 显式域 LLM 管理入口，不读取其他域的 Provider 或用量。 */
export const domainLlmRouter = new Hono<AuthEnv>();
const prefix = "/domains/:slug/llm";
domainLlmRouter.use(`${prefix}/*`, authMiddleware, async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
domainLlmRouter.get(
  `${prefix}/model-aliases`,
  async (c) =>
    c.json({
      data: await readDomainLlmModelAliases(c.req.param("slug")!, c.var.userId),
    }),
);
domainLlmRouter.put(`${prefix}/model-aliases/:alias`, async (c) => {
  const input = await parseJsonBody<LlmModelAliasInput>(c);
  assertObjectBody(input);
  return c.json({
    data: await saveDomainLlmModelAlias(
      c.req.param("slug")!,
      c.var.userId,
      c.req.param("alias"),
      input,
      parseLlmRevision(c.req.header("If-Match")),
    ),
  });
});
domainLlmRouter.delete(`${prefix}/model-aliases/:alias`, async (c) => {
  await removeDomainLlmModelAlias(
    c.req.param("slug")!,
    c.var.userId,
    c.req.param("alias"),
    parseLlmRevision(c.req.header("If-Match")),
    c.req.query("force") === "true",
  );
  return c.json({ data: { deleted: true } });
});
domainLlmRouter.post(`${prefix}/providers/:id/test`, async (c) => {
  const input = await parseJsonBody<{ model: string }>(c);
  assertObjectBody(input);
  if (typeof input.model !== "string") {
    throw new BadRequestError("请填写要测试的模型名称", "model_required");
  }
  return c.json({
    data: await testDomainLlmProvider(
      c.req.param("slug")!,
      c.var.userId,
      c.req.param("id"),
      input.model.trim(),
    ),
  });
});
domainLlmRouter.get(
  `${prefix}/settings`,
  async (c) =>
    c.json({
      data: await readDomainLlmSettings(c.req.param("slug")!, c.var.userId!),
    }),
);
domainLlmRouter.put(`${prefix}/settings`, async (c) => {
  const input = await parseJsonBody<
    { provider_id: string | null; model: string | null }
  >(c);
  assertObjectBody(input);
  const header = c.req.header("If-Match");
  const revision = header === undefined
    ? null
    : Number(header.replace(/^"|"$/g, ""));
  if (header !== undefined && !header.replace(/^"|"$/g, "").trim()) {
    throw new BadRequestError("revision 非法");
  }
  return c.json({
    data: await saveDomainLlmSettings(
      c.req.param("slug")!,
      c.var.userId!,
      revision,
      input,
    ),
  });
});
domainLlmRouter.get(
  `${prefix}/providers`,
  async (c) =>
    c.json({
      data: await readDomainLlmProviders(c.req.param("slug")!, c.var.userId!),
    }),
);
domainLlmRouter.post(`${prefix}/providers`, async (c) => {
  const input = await parseJsonBody<LlmProviderInput>(c);
  assertObjectBody(input);
  return c.json({
    data: await addDomainLlmProvider(
      c.req.param("slug")!,
      c.var.userId!,
      input,
      parseLlmRevision(c.req.header("If-Match")),
    ),
  }, 201);
});
domainLlmRouter.put(`${prefix}/providers/:id`, async (c) => {
  const input = await parseJsonBody<Partial<LlmProviderInput>>(c);
  assertObjectBody(input);
  return c.json({
    data: await editDomainLlmProvider(
      c.req.param("slug")!,
      c.var.userId!,
      c.req.param("id")!,
      input,
      parseLlmRevision(c.req.header("If-Match")),
    ),
  });
});
domainLlmRouter.get(
  `${prefix}/quotas`,
  async (c) =>
    c.json(await readDomainLlmQuotas(c.req.param("slug")!, c.var.userId!)),
);
domainLlmRouter.post(`${prefix}/quotas`, async (c) => {
  const input = await parseJsonBody<LlmQuotaInput>(c);
  assertObjectBody(input);
  return c.json({
    data: await saveDomainLlmQuota(
      c.req.param("slug")!,
      c.var.userId!,
      input,
      parseLlmRevision(c.req.header("If-Match")),
    ),
  }, 201);
});
domainLlmRouter.get(`${prefix}/usage`, async (c) => {
  const pagination = parsePagination(c, {
    perPageField: "limit",
    defaultPerPage: 100,
    maxPerPage: 1000,
  });
  return c.json({
    data: await readDomainLlmUsage(c.req.param("slug")!, c.var.userId!, {
      page: pagination.page,
      limit: pagination.perPage,
      user_id: c.req.query("user_id"),
      problem_id: c.req.query("problem_id"),
      submission_id: c.req.query("submission_id"),
      provider_id: c.req.query("provider_id"),
      status: c.req.query("status"),
      start_time: c.req.query("start_time"),
      end_time: c.req.query("end_time"),
    }),
  });
});
