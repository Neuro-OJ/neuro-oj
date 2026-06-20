import { Hono } from "hono";
import { getUserProfile } from "../services/users.ts";

const users = new Hono();

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
