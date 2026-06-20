import { Hono } from "hono";
import { getProblem, listProblems } from "../services/problems.ts";

const router = new Hono();

/**
 * 获取题目列表。
 * 支持分页：?page=1&limit=20
 */
router.get("/", async (c) => {
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);

  const result = await listProblems(page, limit);
  return c.json(result);
});

/**
 * 获取题目详情。
 */
router.get("/:id", async (c) => {
  const id = c.req.param("id");
  const problem = await getProblem(id);
  return c.json(problem);
});

export default router;
