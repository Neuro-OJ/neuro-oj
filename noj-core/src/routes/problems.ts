import { Hono } from "hono";
import { getProblem, listProblems } from "../services/problems.ts";
import { BadRequestError } from "../lib/errors.ts";

const router = new Hono();

/**
 * 获取题目列表。
 * 支持分页：?page=1&limit=20
 */
router.get("/", async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(
    100,
    Math.max(1, parseInt(c.req.query("limit") || "20", 10)),
  );

  // 校验非数字输入
  if (Number.isNaN(page) || Number.isNaN(limit)) {
    throw new BadRequestError("分页参数 page 和 limit 必须为数字");
  }

  const result = await listProblems(page, limit);
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
  const id = c.req.param("id");
  const problem = await getProblem(id);
  return c.json({ data: problem });
});

export default router;
