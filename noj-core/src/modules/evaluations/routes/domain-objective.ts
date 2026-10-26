import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware } from "../../access/identity/middleware/auth.ts";
import { type AuthEnv } from "../../../shared/http/hono-env.ts";
import { enforceSubmissionRateLimit } from "../../platform/contracts/cross-module/system_services_hardening-rate-limit.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import { loadWorkspace } from "../../access/contracts/cross-module/workspace_services_access.ts";
import {
  getDomainObjectiveSubmissionHistory,
  listOwnSubmissionHistory,
} from "../services/own-submission-history.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { submitDomainObjectivePaper } from "../services/objective/domain-objective.ts";
import type { ObjectiveAnswerValue } from "../../problems/types/objective.ts";
import { parseAssignmentOrigin } from "../../../shared/http/assignment-origin.ts";

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
    const submission = await getDomainObjectiveSubmissionHistory(
      c.req.param("slug")!,
      c.var.userId,
      c.req.param("id")!,
    );
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
      assignment: parseAssignmentOrigin(body),
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
