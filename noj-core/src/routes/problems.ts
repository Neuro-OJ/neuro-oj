import { Hono } from "hono";
import { adminMiddleware, authMiddleware } from "../middleware/auth.ts";
import { parseJsonBody } from "../lib/request.ts";
import { BadRequestError } from "../lib/errors.ts";
import {
  createProblem,
  deleteProblem,
  getProblem,
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
 * 获取题目列表。
 * 支持分页与筛选：?page=1&limit=20&difficulty=easy&category_id=xxx&keyword=xxx
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

  const result = await listProblems(query);
  return c.json({
    data: result.items,
    total: result.total,
    page: result.page,
    limit: result.limit,
  });
});

/**
 * 获取题目详情。
 */
router.get("/:id", async (c) => {
  const id = c.req.param("id") as string;
  const problem = await getProblem(id);
  return c.json({ data: problem });
});

/**
 * 创建题目（管理员）。
 * POST /api/v1/problems
 */
router.post("/", authMiddleware, adminMiddleware, async (c) => {
  const body = await parseJsonBody<CreateProblemInput>(c);

  if (!body.title || !body.judge_image || !body.judge_command) {
    throw new BadRequestError(
      "缺少必填字段：title, judge_image, judge_command",
    );
  }

  if (!body.description) {
    throw new BadRequestError("缺少必填字段：description");
  }

  const problem = await createProblem(body);
  return c.json({ data: problem }, 201);
});

/**
 * 全量更新题目（管理员）。
 * PUT /api/v1/problems/:id
 */
router.put("/:id", authMiddleware, adminMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  const body = await parseJsonBody<UpdateProblemInput>(c);
  const problem = await updateProblem(id, body);
  return c.json({ data: problem });
});

/**
 * 删除题目（管理员）。
 * DELETE /api/v1/problems/:id
 */
router.delete("/:id", authMiddleware, adminMiddleware, async (c) => {
  const id = c.req.param("id") as string;
  await deleteProblem(id);
  return c.body(null, 204);
});

export default router;
