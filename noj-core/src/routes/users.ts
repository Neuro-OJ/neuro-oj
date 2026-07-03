import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.ts";
import { parseJsonBody } from "../lib/request.ts";
import { ValidationError } from "../lib/errors.ts";
import { getUserProfile, searchUsers, updateUserProfile } from "../services/users.ts";
import { getMyRanking } from "../services/rankings.ts";

const users = new Hono<{ Variables: { userId: string; userRole: string } }>();

/**
 * 搜索用户。
 * GET /api/v1/users/search?q=关键词
 * 需要登录，用于私信搜索联系人。必须在 /:id/profile 之前注册，
 * 避免 "search" 被捕获为 :id。
 */
users.get("/search", authMiddleware, async (c) => {
  const query = c.req.query("q") || "";
  const result = await searchUsers(query);
  return c.json({ data: result });
});

/**
 * 更新当前用户个人资料。
 * PUT /api/v1/users/me
 * 需要 Bearer token 认证。
 * ⚠️ 该路由必须在 `/:id/profile` 之前注册，避免 "me" 被匹配为 :id。
 */
users.put("/me", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  const body = await parseJsonBody<{ bio?: string }>(c);

  if (body.bio === undefined) {
    throw new ValidationError("缺少必填字段：bio");
  }

  const user = await updateUserProfile(userId, body.bio);
  return c.json({ data: user }, 200);
});

/**
 * 获取用户主页。
 * GET /api/v1/users/:id/profile
 * 公开访问，无需认证。
 * 响应对象额外包含 `rank` 字段（number | null），表示该用户全站榜单排名。
 */
users.get("/:id/profile", async (c) => {
  const userId = c.req.param("id") as string;
  const profile = await getUserProfile(userId);
  // 追加 rank 字段：复用 rankings service 的 getMyRanking，确保排序逻辑一致
  const ranking = await getMyRanking(userId);
  return c.json({ data: { ...profile, rank: ranking?.rank ?? null } }, 200);
});

export default users;
