import { Hono } from "hono";
import type { AuthEnv } from "../../../middleware/auth.ts";
import { BadRequestError } from "../../../lib/errors.ts";
import { listAllProblems } from "../services/problems/problems.ts";

/**
 * 管理端题目管理路由（挂载前缀 /api/v1/admin，见 admin/index.ts）。
 *
 * 提供：
 * - GET /problems 全量题目列表（含 U 型和 P 型）
 */
const router = new Hono<AuthEnv>();

/**
 * 管理员获取全量题目列表（含 U 型和 P 型）。
 * GET /api/v1/admin/problems
 */
router.get("/problems", async (c) => {
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);

  if (Number.isNaN(page) || Number.isNaN(limit)) {
    throw new BadRequestError("分页参数 page 和 limit 必须为数字");
  }

  const result = await listAllProblems({
    page: Math.max(1, page),
    limit: Math.min(100, Math.max(1, limit)),
    difficulty: c.req.query("difficulty") || undefined,
    tag: c.req.query("tag") || undefined,
    keyword: c.req.query("keyword") || undefined,
  });

  return c.json({
    data: result.items,
    total: result.total,
    page: result.page,
    limit: result.limit,
  });
});

export default router;
