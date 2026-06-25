import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.ts";
import { parseJsonBody } from "../lib/request.ts";
import { BadRequestError, NotFoundError } from "../lib/errors.ts";
import {
  createProblem,
  deleteProblem,
  getProblem,
  getProblemByTypeAndNumber,
  listProblems,
  updateProblem,
} from "../services/problems.ts";
import type {
  CreateProblemInput,
  ProblemListQuery,
  UpdateProblemInput,
} from "../types/problems.ts";

const router = new Hono<{ Variables: { userId: string; userRole: string } }>();

/**
 * 双索引查找工具函数。
 * 支持通过 UUID 或 display_id（如 P1001）两种格式查找题目。
 * 捕获 NotFoundError 后尝试下一种查找方式，其他异常直接透传。
 */
async function resolveProblem(id: string) {
  // 尝试 1：按 UUID / id 精确查找
  try {
    return await getProblem(id);
  } catch (err) {
    // 非 NotFoundError（如 DB 连接异常）直接透传，不吞错
    if (!(err instanceof NotFoundError)) throw err;
  }

  // 尝试 2：解析 display_id "P1001" / "U42" → (type, number)
  const match = id.match(/^([UuPp])(\d+)$/);
  if (match) {
    const type = match[1].toUpperCase();
    const number = parseInt(match[2], 10);
    return await getProblemByTypeAndNumber(type, number);
  }

  throw new NotFoundError("题目不存在");
}

/**
 * 获取题目列表。
 * 支持分页与筛选：?page=1&limit=20&difficulty=easy&category_id=xxx&keyword=xxx&type=U&number=1001
 */
router.get("/", async (c) => {
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);

  // 校验非数字输入
  if (Number.isNaN(page) || Number.isNaN(limit)) {
    throw new BadRequestError("分页参数 page 和 limit 必须为数字");
  }

  const query: ProblemListQuery = {
    page: Math.max(1, page),
    limit: Math.min(100, Math.max(1, limit)),
  };

  const difficulty = c.req.query("difficulty");
  if (difficulty) query.difficulty = difficulty;

  const categoryId = c.req.query("category_id");
  if (categoryId) query.category_id = categoryId;

  const keyword = c.req.query("keyword");
  if (keyword) query.keyword = keyword;

  const type = c.req.query("type");
  if (type) query.type = type;

  const numberStr = c.req.query("number");
  if (numberStr) {
    const number = parseInt(numberStr, 10);
    if (!Number.isNaN(number)) query.number = number;
  }

  const result = await listProblems(query);
  return c.json({
    data: result.items,
    total: result.total,
    page: result.page,
    limit: result.limit,
  });
});

/**
 * 获取题目详情（双索引：UUID 或 display_id）。
 */
router.get("/:id", async (c) => {
  const id = c.req.param("id") as string;
  const problem = await resolveProblem(id);
  return c.json({ data: problem });
});

/**
 * 创建题目。
 * admin 可创建任意 type，普通用户仅限 U 型。
 * POST /api/v1/problems
 */
router.post("/", authMiddleware, async (c) => {
  const body = await parseJsonBody<CreateProblemInput>(c);

  if (!body.title || !body.judge_image || !body.judge_command) {
    throw new BadRequestError(
      "缺少必填字段：title, judge_image, judge_command",
    );
  }

  if (!body.description) {
    throw new BadRequestError("缺少必填字段：description");
  }

  const userId = c.get("userId");
  const userRole = c.get("userRole");
  const problem = await createProblem(body, userId, userRole);
  return c.json({ data: problem }, 201);
});

/**
 * 全量更新题目（双索引：UUID 或 display_id）。
 * 权限在服务层按 type+owner 判断。
 */
router.put("/:id", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const body = await parseJsonBody<UpdateProblemInput>(c);
  const userId = c.get("userId");
  const userRole = c.get("userRole");

  // 双索引解析获取实际题目 ID
  const problem = await resolveProblem(id);
  const updated = await updateProblem(problem.id, body, userId, userRole);
  return c.json({ data: updated });
});

/**
 * 删除题目（双索引：UUID 或 display_id）。
 * 权限在服务层按 type+owner 判断。
 */
router.delete("/:id", authMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const userId = c.get("userId");
  const userRole = c.get("userRole");

  // 双索引解析获取实际题目 ID
  const problem = await resolveProblem(id);
  await deleteProblem(problem.id, userId, userRole);
  return c.body(null, 204);
});

export default router;
