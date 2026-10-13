import { Hono } from "hono";
import type { Context } from "hono";
import { type AuthEnv, authMiddleware } from "../../identity/index.ts";
import { enforceSubmissionRateLimit } from "../../system/index.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import { loadWorkspace } from "../../workspace/index.ts";
import {
  getOwnSubmissionHistory,
  listOwnSubmissionHistory,
} from "../../submission/index.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { submitDomainObjectivePaper } from "../services/domain-objective.ts";
import type { ObjectiveAnswerValue } from "../types/objective.ts";

/** 使用域客观题入口，正式交卷与本人历史均保留使用域归属。 */
export const domainObjectiveRouter = new Hono<AuthEnv>();
domainObjectiveRouter.get(
  "/domains/:slug/objective-submissions",
  authMiddleware,
  async (c) => {
    const { domain } = await loadWorkspace(c.req.param("slug")!, c.var.userId);
    const page = Number(c.req.query("page") ?? 1),
      perPage = Number(c.req.query("per_page") ?? 20);
    if (
      !Number.isSafeInteger(page) || page < 1 ||
      !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100
    ) {
      throw new BadRequestError("分页范围无效");
    }
    c.header("Cache-Control", "no-store");
    return c.json(
      await listOwnSubmissionHistory(c.var.userId, page, perPage, {
        domainId: domain.id,
        kind: "objective",
        problemId: c.req.query("problem_id"),
      }),
    );
  },
);
domainObjectiveRouter.get(
  "/domains/:slug/objective-submissions/:id",
  authMiddleware,
  async (c) => {
    const { domain } = await loadWorkspace(c.req.param("slug")!, c.var.userId);
    const submission = await getOwnSubmissionHistory(
      c.var.userId,
      "objective",
      c.req.param("id")!,
    );
    if (submission.domain.id !== domain.id) {
      throw new NotFoundError("提交不存在");
    }
    c.header("Cache-Control", "no-store");
    return c.json({ data: submission });
  },
);
const submitInDomain = async (c: Context<AuthEnv>) => {
  const body = await parseJsonBody<Record<string, unknown>>(c);
  assertObjectBody(body);
  assertObjectBody(body.answers);
  if (
    body.contest_id !== undefined || body.domain_id !== undefined ||
    body.domain_problem_binding_id !== undefined
  ) throw new BadRequestError("交卷上下文由使用域入口解析");
  await enforceSubmissionRateLimit(c, c.var.userId);
  const result = await submitDomainObjectivePaper(
    c.req.param("slug")!,
    c.req.param("label") ?? c.req.param("reference")!,
    c.var.userId,
    {
      answers: body.answers as Record<string, ObjectiveAnswerValue[]>,
      version_id: typeof body.version_id === "string"
        ? body.version_id
        : undefined,
    },
    c.req.param("id"),
  );
  c.header("Cache-Control", "no-store");
  return c.json({ data: result }, 201);
};
domainObjectiveRouter.post(
  "/domains/:slug/problems/:reference/objective-submissions",
  authMiddleware,
  submitInDomain,
);
domainObjectiveRouter.post(
  "/domains/:slug/contests/:id/problems/:label/objective-submissions",
  authMiddleware,
  submitInDomain,
);
