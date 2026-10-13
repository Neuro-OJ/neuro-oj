import { Hono } from "hono";
import type { Context } from "hono";
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
import {
  cancelDomainSelfTest,
  getDomainSelfTest,
} from "../services/domain-self-test-read.ts";
import {
  getDomainSubmission,
  listDomainSubmissions,
} from "../services/domain-submission-read.ts";
import {
  buildPaginationMeta,
  parsePagination,
} from "../../../shared/http/pagination.ts";

/** 显式域执行入口，受理事务重新检查使用域、版本及源资源授权。 */
export const domainSubmissionsRouter = new Hono<AuthEnv>();
domainSubmissionsRouter.get(
  "/domains/:slug/self-tests/:id",
  authMiddleware,
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await getDomainSelfTest(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.var.userId,
        c,
      ),
    });
  },
);
domainSubmissionsRouter.post(
  "/domains/:slug/self-tests/:id/cancel",
  authMiddleware,
  async (c) => {
    await cancelDomainSelfTest(
      c.req.param("slug")!,
      c.req.param("id")!,
      c.var.userId,
      c,
    );
    c.header("Cache-Control", "no-store");
    return c.json({ data: { cancel_requested: true } });
  },
);
domainSubmissionsRouter.get(
  "/domains/:slug/submissions",
  authMiddleware,
  async (c) => {
    const { page, perPage } = parsePagination(c, { maxPerPage: 100 });
    const result = await listDomainSubmissions(
      c.req.param("slug")!,
      c.var.userId,
      {
        page,
        perPage,
        problemId: c.req.query("problem_id"),
        contestId: c.req.query("contest_id"),
      },
    );
    c.header("Cache-Control", "no-store");
    return c.json({
      data: result.data,
      pagination: buildPaginationMeta(page, perPage, result.total),
    });
  },
);
domainSubmissionsRouter.get(
  "/domains/:slug/submissions/:id",
  authMiddleware,
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      data: await getDomainSubmission(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.var.userId,
      ),
    });
  },
);
const submitInDomain = async (c: Context<AuthEnv>) => {
  const contestId = c.req.param("id");
  const label = c.req.param("label");
  if (c.req.header("content-type")?.startsWith("multipart/form-data")) {
    const parsed = await parseArtifactMultipart(c, "problem_ref", label);
    await enforceSubmissionRateLimit(c, c.var.userId);
    const result = await createDomainArtifactSubmission(
      c.req.param("slug")!,
      parsed.problem_id,
      c.var.userId,
      parsed,
      contestId,
    );
    c.header("Cache-Control", "no-store");
    return c.json({ data: result }, 201);
  }
  const body = await parseJsonBody<Record<string, unknown>>(c);
  assertObjectBody(body);
  const problemRef = label ?? body.problem_ref;
  if (
    typeof problemRef !== "string" || !problemRef ||
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
    problemRef,
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
    contestId,
  );
  c.header("Cache-Control", "no-store");
  return c.json({ data: result }, 201);
};
domainSubmissionsRouter.post(
  "/domains/:slug/submissions",
  authMiddleware,
  submitInDomain,
);
domainSubmissionsRouter.post(
  "/domains/:slug/contests/:id/problems/:label/submissions",
  authMiddleware,
  submitInDomain,
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
