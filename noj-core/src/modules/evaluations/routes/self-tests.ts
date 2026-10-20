import { Hono } from "hono";
import {
  type AuthEnv,
  authMiddleware,
  checkPermission,
} from "../../../domains/identity/index.ts";
import { parseJsonBody } from "../../../shared/http/request.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import { enforceSelfTestRateLimit } from "../../../domains/system/index.ts";
import { resolveProblem } from "../../problems/index.ts";
import {
  composeEvaluationAdmissionContext,
  submitSelfTestCommand,
} from "../../application/evaluations.ts";
import {
  cancelSelfTest,
  getSelfTest,
  listMySelfTests,
} from "../services/self-tests.ts";
import type { SelfTestInput } from "../types/self-tests.ts";

const router = new Hono<AuthEnv>();

/** 自测代码最大长度（与正式提交一致）。 */
const MAX_CODE_LENGTH = 100 * 1024;

/**
 * 创建自测。
 * POST /api/v1/problems/:id/self-test
 */
router.post("/problems/:id/self-test", authMiddleware, async (c) => {
  const actor = c.var.actor;
  const problemId = c.req.param("id") as string;

  // 先做 body 解析与代码大小校验，再查询题目与限流，避免超大/格式错误请求消耗配额与 DB
  const body = await parseJsonBody<Record<string, unknown>>(c);

  if (!body.language || !body.code) {
    const missing: string[] = [];
    if (!body.language) missing.push("language");
    if (!body.code) missing.push("code");
    throw new BadRequestError(`缺少必填字段: ${missing.join(", ")}`);
  }

  if (typeof body.code !== "string") {
    throw new BadRequestError("code 字段必须为字符串");
  }
  if (body.code.length > MAX_CODE_LENGTH) {
    throw new BadRequestError(
      `代码长度超过限制（${MAX_CODE_LENGTH} 字符），请精简后重新提交`,
    );
  }

  // 自测专用限流（IP + 用户双维度）在校验通过后执行
  await enforceSelfTestRateLimit(c, actor.userId);

  // 题目双索引解析（不存在时抛 404；返回真实 UUID 供 service 使用）
  const problem = await resolveProblem(problemId);

  const input: SelfTestInput = {
    language: body.language as string,
    code: body.code as string,
    file_name: body.file_name as string | undefined,
    cases: body.cases as SelfTestInput["cases"],
    version_id: typeof body.version_id === "string" && body.version_id
      ? body.version_id
      : undefined,
  };

  const context = await composeEvaluationAdmissionContext(actor, {
    problemId: problem.id,
    versionId: input.version_id,
  });
  const result = await submitSelfTestCommand(
    actor,
    context,
    problem.id,
    input,
  );
  return c.json({ data: result }, 201);
});

/**
 * 列出当前用户在某题下的自测（运行历史，不含代码）。
 * GET /api/v1/problems/:id/self-tests?limit=20
 */
router.get("/problems/:id/self-tests", authMiddleware, async (c) => {
  const userId = c.var.userId as string;
  const problem = await resolveProblem(c.req.param("id") as string);
  const limit = Number(c.req.query("limit") ?? "");
  const isAdmin = await checkPermission(c, "submission:read_all");
  const data = await listMySelfTests(
    userId,
    problem.id,
    Number.isFinite(limit) && limit > 0 ? limit : undefined,
    isAdmin,
  );
  return c.json({ data });
});

/**
 * 查询自测详情。
 * GET /api/v1/self-tests/:id
 */
router.get("/self-tests/:id", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const result = await getSelfTest(id, c);
  return c.json({ data: result });
});

router.post("/self-tests/:id/cancel", authMiddleware, async (c) => {
  await cancelSelfTest(c.req.param("id") as string, c);
  return c.json({ data: { cancel_requested: true } });
});

export default router;
