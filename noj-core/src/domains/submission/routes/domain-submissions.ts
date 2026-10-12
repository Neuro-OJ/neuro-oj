import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "../../identity/index.ts";
import {
  enforceSelfTestRateLimit,
  enforceSubmissionRateLimit,
} from "../../system/index.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import {
  createDomainArtifactSubmission,
  createDomainSelfTest,
  createDomainSubmission,
} from "../services/domain-submissions.ts";
import { parseArtifactMultipart } from "./submissions.ts";
import type { SelfTestInput } from "../types/self-tests.ts";

/** 隔离阶段准备入口；组合根在全部提交／查询隔离完成后统一开放。 */
export const domainSubmissionsRouter = new Hono<AuthEnv>();
domainSubmissionsRouter.post(
  "/domains/:slug/submissions",
  authMiddleware,
  async (c) => {
    if (c.req.header("content-type")?.startsWith("multipart/form-data")) {
      const parsed = await parseArtifactMultipart(c, "problem_ref");
      await enforceSubmissionRateLimit(c, c.var.userId);
      const result = await createDomainArtifactSubmission(
        c.req.param("slug")!,
        parsed.problem_id,
        c.var.userId,
        parsed,
      );
      c.header("Cache-Control", "no-store");
      return c.json({ data: result }, 201);
    }
    const body = await parseJsonBody<Record<string, unknown>>(c);
    assertObjectBody(body);
    if (
      typeof body.problem_ref !== "string" || !body.problem_ref ||
      typeof body.language !== "string" || !body.language ||
      typeof body.code !== "string" || !body.code
    ) {
      throw new BadRequestError("problem_ref、language 与 code 必填");
    }
    if (body.code.length > 100 * 1024) {
      throw new BadRequestError(
        "代码长度超过 100KB 限制",
      );
    }
    if (
      body.contest_id !== undefined || body.domain_id !== undefined ||
      body.domain_problem_binding_id !== undefined
    ) {
      throw new BadRequestError("提交上下文由使用域入口解析");
    }
    await enforceSubmissionRateLimit(c, c.var.userId);
    const result = await createDomainSubmission(
      c.req.param("slug")!,
      body.problem_ref,
      c.var.userId,
      {
        language: body.language,
        code: body.code,
        file_name: typeof body.file_name === "string"
          ? body.file_name
          : undefined,
        version_id: typeof body.version_id === "string"
          ? body.version_id
          : undefined,
      },
    );
    c.header("Cache-Control", "no-store");
    return c.json({ data: result }, 201);
  },
);

domainSubmissionsRouter.post(
  "/domains/:slug/problems/:reference/self-tests",
  authMiddleware,
  async (c) => {
    const body = await parseJsonBody<Record<string, unknown>>(c);
    assertObjectBody(body);
    if (
      typeof body.code !== "string" || !body.code ||
      typeof body.language !== "string" || !body.language
    ) throw new BadRequestError("code 与 language 必填");
    if (body.code.length > 100 * 1024) {
      throw new BadRequestError(
        "代码长度超过 100KB 限制",
      );
    }
    await enforceSelfTestRateLimit(c, c.var.userId);
    const result = await createDomainSelfTest(
      c.req.param("slug")!,
      c.req.param("reference")!,
      c.var.userId,
      {
        code: body.code,
        language: body.language,
        file_name: typeof body.file_name === "string"
          ? body.file_name
          : undefined,
        version_id: typeof body.version_id === "string"
          ? body.version_id
          : undefined,
        cases: body.cases as SelfTestInput["cases"],
      },
    );
    c.header("Cache-Control", "no-store");
    return c.json({ data: result }, 201);
  },
);
