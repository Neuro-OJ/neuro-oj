import { Hono } from "hono";
import { createSubmission, getSubmission } from "../services/submissions.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { BadRequestError } from "../lib/errors.ts";

// 扩展 Hono 类型，使 c.get("userId") 返回 string
type Env = {
  Variables: {
    userId: string;
    userRole: string;
  };
};

const router = new Hono<Env>();

/**
 * 创建提交。
 */
router.post("/", authMiddleware, async (c) => {
  const userId = c.var.userId!;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    throw new BadRequestError("请求体格式错误：需要有效的 JSON");
  }

  // 必填字段验证
  if (!body.problem_id || !body.language || !body.code) {
    const missing: string[] = [];
    if (!body.problem_id) missing.push("problem_id");
    if (!body.language) missing.push("language");
    if (!body.code) missing.push("code");
    throw new BadRequestError(`缺少必填字段: ${missing.join(", ")}`);
  }

  const result = await createSubmission(userId, {
    problem_id: body.problem_id as string,
    language: body.language as string,
    code: body.code as string,
    file_name: body.file_name as string | undefined,
  });

  return c.json({ data: result }, 201);
});

/**
 * 获取提交详情。
 */
router.get("/:id", authMiddleware, async (c) => {
  const id = c.req.param("id")!;

  const result = await getSubmission(id, c.var.userId);
  return c.json({ data: result });
});

export default router;
