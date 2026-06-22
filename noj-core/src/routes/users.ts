import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.ts";
import { parseJsonBody } from "../lib/request.ts";
import { ValidationError } from "../lib/errors.ts";
import { getUserProfile, updateUserProfile } from "../services/users.ts";

const users = new Hono<{ Variables: { userId: string; userRole: string } }>();

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
 */
users.get("/:id/profile", async (c) => {
  const userId = c.req.param("id") as string;
  const profile = await getUserProfile(userId);
  return c.json({ data: profile }, 200);
});

export default users;
