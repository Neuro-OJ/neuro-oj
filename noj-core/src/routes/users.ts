import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.ts";
import { parseJsonBody } from "../lib/request.ts";
import { BadRequestError, ValidationError } from "../lib/errors.ts";
import {
  clearUserAvatar,
  getUserAvatarBytes,
  getUserProfileAggregate,
  resolveUserId,
  searchUsers,
  updateUserAvatar,
  updateUserProfile,
} from "../services/users.ts";
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
 * 上传/替换当前用户头像。
 * POST /api/v1/users/me/avatar
 * multipart `file` 字段；校验 png/jpeg/webp、≤2MB、magic bytes。
 */
users.post("/me/avatar", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || !(file instanceof File)) {
    throw new BadRequestError("请上传有效的图片文件");
  }
  const result = await updateUserAvatar(userId, file);
  return c.json({ data: result }, 200);
});

/**
 * 删除当前用户头像（幂等）。
 * DELETE /api/v1/users/me/avatar
 */
users.delete("/me/avatar", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  await clearUserAvatar(userId);
  return c.body(null, 204);
});

/**
 * 获取用户头像（公开）。
 * GET /api/v1/users/:id/avatar
 * 无头像 → 404；有 → 图片字节流 + 缓存头（ETag = 内容 checksum）。
 */
users.get("/:id/avatar", async (c) => {
  const userId = await resolveUserId(c.req.param("id") as string);
  const { bytes, contentType, etag } = await getUserAvatarBytes(userId);
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
      "ETag": etag,
    },
  });
});

/**
 * 获取用户主页。
 * GET /api/v1/users/:id/profile
 * 公开访问，无需认证。
 * 响应对象额外包含 `rank` 字段（number | null），表示该用户全站榜单排名。
 */
users.get("/:id/profile", async (c) => {
  const userId = await resolveUserId(c.req.param("id") as string);
  const profile = await getUserProfileAggregate(userId);
  // 追加 rank 字段：复用 rankings service 的 getMyRanking，确保排序逻辑一致
  const ranking = await getMyRanking(userId);
  return c.json({ data: { ...profile, rank: ranking?.rank ?? null } }, 200);
});

export default users;
