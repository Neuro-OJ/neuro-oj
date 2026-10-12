import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "../../identity/index.ts";
import { enforceSubmissionRateLimit } from "../../system/index.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { submitDomainObjectivePaper } from "../services/domain-objective.ts";
import type { ObjectiveAnswerValue } from "../types/objective.ts";

/** 使用域客观题准备入口，隔离阶段完成后统一开放。 */
export const domainObjectiveRouter = new Hono<AuthEnv>();
domainObjectiveRouter.post(
  "/domains/:slug/problems/:reference/objective-submissions",
  authMiddleware,
  async (c) => {
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
      c.req.param("reference")!,
      c.var.userId,
      {
        answers: body.answers as Record<string, ObjectiveAnswerValue[]>,
        version_id: typeof body.version_id === "string"
          ? body.version_id
          : undefined,
      },
    );
    c.header("Cache-Control", "no-store");
    return c.json({ data: result }, 201);
  },
);
