import { Hono } from "hono";
import { authMiddleware } from "../../../middleware/auth.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import { BadRequestError } from "./../../../shared/base/errors.ts";
import { enforceSelfTestRateLimit } from "../../system/index.ts";
import { resolveProblem } from "./../../catalog/index.ts";
import { createSelfTest, getSelfTest } from "../services/self-tests.ts";
import type { SelfTestInput } from "../../../types/self-tests.ts";

type Env = {
  Variables: {
    userId?: string;
    userRole?: string;
  };
};

const router = new Hono<Env>();

/** 自测代码最大长度（与正式提交一致）。 */
const MAX_CODE_LENGTH = 100 * 1024;

/**
 * 创建自测。
 * POST /api/v1/problems/:id/self-test
 */
router.post("/problems/:id/self-test", authMiddleware, async (c) => {
  const userId = c.var.userId as string;
  const problemId = c.req.param("id") as string;

  // 自测专用限流（IP + 用户双维度）
  await enforceSelfTestRateLimit(c, userId);

  // 先做 body 解析与代码大小校验，再查询题目，避免超大请求先触发 DB 读
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

  // 题目双索引解析（不存在时抛 404；返回真实 UUID 供 service 使用）
  const problem = await resolveProblem(problemId);

  const input: SelfTestInput = {
    language: body.language as string,
    code: body.code as string,
    file_name: body.file_name as string | undefined,
  };

  const result = await createSelfTest(userId, problem.id, input);
  return c.json({ data: result }, 201);
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

export default router;
