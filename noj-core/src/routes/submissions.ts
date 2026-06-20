import { Hono } from "hono";
import { createSubmission, getSubmission } from "../services/submissions.ts";
import { verifyToken } from "../lib/jwt.ts";

// 扩展 Hono 类型
type Env = {
  Variables: {
    userId: string;
  };
};

const router = new Hono<Env>();

/**
 * 中间件：从 JWT 获取用户 ID。
 */
router.use("/*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "缺少认证信息" }, 401);
  }

  const token = authHeader.slice(7);
  const payload = await verifyToken(token);
  if (!payload) {
    return c.json({ error: "无效的 token" }, 401);
  }

  c.set("userId", payload.sub);
  await next();
});

/**
 * 创建提交。
 */
router.post("/", async (c) => {
  const userId = c.get("userId") as string;
  const body = await c.req.json();

  const result = await createSubmission(userId, {
    problem_id: body.problem_id,
    language: body.language,
    code: body.code,
    file_name: body.file_name,
  });

  return c.json(result, 201);
});

/**
 * 获取提交详情。
 */
router.get("/:id", async (c) => {
  const id = c.req.param("id");
  const userId = c.get("userId") as string;

  const result = await getSubmission(id, userId);
  return c.json(result);
});

export default router;
