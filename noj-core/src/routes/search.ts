import { Hono } from "hono";
import { ForbiddenError, ValidationError } from "../lib/errors.ts";
import { searchProblems, searchUsers } from "../services/search.ts";
import { optionalAuthMiddleware } from "../middleware/auth.ts";

const search = new Hono<{ Variables: { userId: string; userRole: string } }>();

// 全文搜索 route 在 type=problem 时对匿名访问开放，
// 因此用 optionalAuthMiddleware 解析 token（若有）但不强制。
search.use("*", optionalAuthMiddleware);

/**
 * 全文搜索（issue #100）。
 *
 * GET /api/v1/search?q=<query>&type=problem|user&page=1&limit=20
 *
 * 权限：
 *   - type=problem：公开访问（无需登录），任何调用者可用
 *   - type=user：要求 admin 角色（依赖已登录用户上下文，未登录等同于非 admin）
 *
 * 必须在所有 `/:id/...` 类路由之前注册，避免被 `/:id` 吞掉。
 */
search.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const type = (c.req.query("type") ?? "problem").trim();
  const page = parseInt(c.req.query("page") ?? "1", 10);
  const limit = parseInt(c.req.query("limit") ?? "20", 10);

  // 参数校验
  if (q.length < 1 || q.length > 100) {
    throw new ValidationError("q 长度必须在 1-100 之间");
  }
  if (type !== "problem" && type !== "user") {
    throw new ValidationError("type 必须为 problem 或 user");
  }
  if (!Number.isFinite(page) || page < 1) {
    throw new ValidationError("page 必须为正整数");
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    throw new ValidationError("limit 必须在 1-100 之间");
  }

  // 权限校验：type=user 必须 admin
  // 未登录时 userRole 为 undefined，等同于非 admin
  if (type === "user") {
    const userRole = c.get("userRole");
    if (userRole !== "admin") {
      throw new ForbiddenError("仅管理员可搜索用户");
    }
  }

  // 分发
  if (type === "problem") {
    const data = await searchProblems(q, page, limit);
    return c.json({ data }, 200);
  }
  const data = await searchUsers(q, page, limit);
  return c.json({ data }, 200);
});

export default search;
