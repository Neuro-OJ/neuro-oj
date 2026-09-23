import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "./../middleware/auth.ts";
import { optionalAuthMiddleware } from "./../middleware/auth.ts";
import { checkPermission } from "./../services/security/permissions.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import {
  BadRequestError,
  ValidationError,
} from "./../../../shared/base/errors.ts";
import {
  clearUserAvatar,
  getUserAvatarBytes,
  getUserProfileAggregate,
  resolveUserId,
  searchUsers,
  updateUserAvatar,
  updateUserProfile,
} from "../services/users.ts";
import { getMyRanking } from "../../query/index.ts";
import { deleteOwnAccount } from "../services/account-deletion.ts";
import { getClientIp } from "../../system/index.ts";
import { buildUserDataExport } from "../services/me-data-export.ts";
import { enforceRateLimit } from "../../system/index.ts";

const users = new Hono<AuthEnv>();

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
  await enforceRateLimit(`users-me:user:${userId}`, { windowSec: 30, max: 10 });
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
  await enforceRateLimit(`users-avatar:user:${userId}`, {
    windowSec: 60,
    max: 5,
  });
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
  await enforceRateLimit(`users-avatar:user:${userId}`, {
    windowSec: 60,
    max: 5,
  });
  await clearUserAvatar(userId);
  return c.body(null, 204);
});

/** 注销当前账户。需要再次确认当前密码。 */
users.post("/me/delete-account", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  await enforceRateLimit(`users-delete:user:${userId}`, {
    windowSec: 300,
    max: 3,
  });
  const body = await parseJsonBody<{ password?: string }>(c);
  await deleteOwnAccount(c.get("userId"), body.password ?? "", getClientIp(c));
  return c.body(null, 204);
});

/**
 * 导出当前用户的个人信息（PIPL 第 45 条：查阅、复制权）。
 * GET /api/v1/users/me/data-export
 * 返回本人账户、提交、社区内容与同意记录的 JSON。
 * 低频重读端点，按用户维度限流。
 */
users.get("/me/data-export", authMiddleware, async (c) => {
  const userId = c.get("userId") as string;
  await enforceRateLimit(`data-export:user:${userId}`, {
    windowSec: 60,
    max: 5,
  });
  const data = await buildUserDataExport(userId);
  if (!data) {
    throw new BadRequestError("用户不存在");
  }
  c.header(
    "Content-Disposition",
    `attachment; filename="noj-data-export-${userId}.json"`,
  );
  return c.json({ data });
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
 * 公开访问，可选认证（登录的审核员看到赛事题解，普通访问者看不到）。
 * 响应对象额外包含 `rank` 字段（number | null），表示该用户全站榜单排名。
 *
 * 赛期门控（2026-09-14 评审 High#1/#2）：题解列表与题解计数按审核员身份区分。
 * 未登录时 `c.get("userId")` 为 undefined，`checkPermission` 权限集为空 → false。
 */
users.get("/:id/profile", optionalAuthMiddleware, async (c) => {
  const userId = await resolveUserId(c.req.param("id") as string);
  // admin:full_access 通配放行由 checkPermission 内部处理
  const moderator = await checkPermission(c, "community_moderation:review");
  const profile = await getUserProfileAggregate(userId, moderator);
  // 追加 rank 字段：复用 rankings service 的 getMyRanking，确保排序逻辑一致
  const ranking = await getMyRanking(userId);
  return c.json({ data: { ...profile, rank: ranking?.rank ?? null } }, 200);
});

export default users;
