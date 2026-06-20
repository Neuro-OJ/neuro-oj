/**
 * 题目路由
 *
 * 提供题目相关 API：
 * - GET /api/v1/problems — 题目列表
 * - GET /api/v1/problems/:id — 题目详情
 */

import { Hono } from "hono";
import * as problems from "../services/problems.ts";

const router = new Hono();

/**
 * GET /api/v1/problems — 题目列表
 */
router.get("/", (c) => {
  const list = problems.listProblems();
  return c.json({ data: list });
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