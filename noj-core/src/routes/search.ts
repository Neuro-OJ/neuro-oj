/**
 * 全局搜索路由（issue #100）。
 *
 * GET /api/v1/search?q=<query>&type=problem|user&page=1&limit=20&include_u=false
 *
 * 权限：
 * - type=problem: 公开（默认仅 P 型；admin + include_u=true 返回 U+P）
 * - type=user: admin only
 *
 * 限流：由 app.ts 以匿名 IP 桶的路径级中间件统一处理。
 */

import { Hono } from "hono";
import { optionalAuthMiddleware } from "../middleware/auth.ts";
import { searchProblems, searchUsers } from "../services/search.ts";
import { parsePagination } from "../lib/pagination.ts";
import {
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "../lib/errors.ts";

// 扩展 Hono 类型，使 c.get("userId") / c.get("userRole") 返回 string | undefined
// （optionalAuthMiddleware 注入时可能为 undefined；与 submissions.ts 一致）
type Env = {
  Variables: {
    userId?: string;
    userRole?: string;
  };
};

const router = new Hono<Env>();

/**
 * GET /api/v1/search
 */
router.get("/", optionalAuthMiddleware, async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const type = c.req.query("type") ?? "problem";
  const includeUParam = c.req.query("include_u");
  const includeU = includeUParam === "true" || includeUParam === "1";

  // 解析 userRole（未登录为 undefined）
  const isAdmin = c.var.userRole === "admin";

  // 校验
  if (q.length < 2) {
    throw new ValidationError("搜索关键词至少需要 2 个字符");
  }
  if (q.length > 100) {
    throw new ValidationError("搜索关键词最多 100 个字符");
  }
  if (type !== "problem" && type !== "user") {
    throw new ValidationError("type 参数必须为 problem 或 user");
  }

  // 用户搜索：admin only
  if (type === "user" && !isAdmin) {
    // 未登录返回 401，非 admin 返回 403
    if (!c.var.userId) {
      throw new UnauthorizedError("请先登录");
    }
    throw new ForbiddenError("仅管理员可搜索用户");
  }

  // 解析分页（PR-6 评审修订：使用 parsePagination helper）
  const { page, perPage: limit } = parsePagination(c, {
    defaultPerPage: 20,
    maxPerPage: 50,
  });

  // 调用 service
  if (type === "problem") {
    const result = await searchProblems({
      q,
      isAdmin,
      includeU,
      page,
      limit,
    });
    c.header("X-Search-Took-Ms", String(result.took_ms));
    return c.json({
      data: {
        query: q,
        type,
        items: result.items,
        total: result.total,
        page,
        limit,
        took_ms: result.took_ms,
      },
    });
  }

  // type === "user"
  const result = await searchUsers({ q, isAdmin, page, limit });
  c.header("X-Search-Took-Ms", String(result.took_ms));
  return c.json({
    data: {
      query: q,
      type,
      items: result.items,
      total: result.total,
      page,
      limit,
      took_ms: result.took_ms,
    },
  });
});

export default router;
