/**
 * 题目路由
 *
 * 提供题目相关 API：
 * - GET /api/v1/problems — 题目列表
 * - POST /api/v1/problems — 创建题目
 * - GET /api/v1/problems/:id — 题目详情
 */

import { Hono } from "hono";
import * as problems from "../services/problems.ts";
import type { CreateProblemInput } from "../types/problems.ts";

const router = new Hono();

/**
 * GET /api/v1/problems — 题目列表（支持分页）
 */
router.get("/", (c) => {
  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "20");

  const allProblems = problems.listProblems();
  const start = (page - 1) * limit;
  const end = start + limit;
  const data = allProblems.slice(start, end);

  return c.json({
    data,
    pagination: {
      page,
      limit,
      total: allProblems.length,
      total_pages: Math.ceil(allProblems.length / limit),
    },
  });
});

/**
 * POST /api/v1/problems — 创建题目
 */
router.post("/", async (c) => {
  const body = await c.req.json<CreateProblemInput>();

  if (!body.title) {
    return c.json({ error: "title is required" }, 400);
  }
  if (!body.description) {
    return c.json({ error: "description is required" }, 400);
  }
  if (!body.judge_image) {
    return c.json({ error: "judge_image is required" }, 400);
  }
  if (!body.judge_command) {
    return c.json({ error: "judge_command is required" }, 400);
  }

  const problem = problems.createProblem(body);
  return c.json({ data: problem }, 201);
});

/**
 * GET /api/v1/problems/:id — 题目详情
 */
router.get("/:id", (c) => {
  const id = c.req.param("id");
  const problem = problems.getProblem(id);

  if (!problem) {
    return c.json({ error: "Problem not found" }, 404);
  }

  return c.json({ data: problem });
});

export default router;