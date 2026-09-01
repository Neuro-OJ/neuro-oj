import { Hono } from "hono";
import { authMiddleware } from "../../../middleware/auth.ts";
import { parseJsonBody } from "../../../lib/request.ts";
import {
  BadRequestError,
  NotFoundError,
  ValidationError,
} from "../../../lib/errors.ts";
import {
  createUserLlmProvider,
  deleteUserLlmProvider,
  listUserLlmProviders,
  LlmGatewayError,
  testUserLlmProvider,
  updateUserLlmProvider,
} from "../../gateway/index.ts";
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

const users = new Hono<{ Variables: { userId: string; userRole: string } }>();

/**
 * 将 LLM 网关错误映射为对应的 HTTP 错误。
 * @param error 捕获的异常
 * @returns 永不返回（总是抛出映射后的错误）
 * @throws {NotFoundError} 网关返回 404（模型配置不存在）
 * @throws {BadRequestError} 网关返回 400 或服务不可用
 */
function mapLlmError(error: unknown): never {
  if (error instanceof LlmGatewayError) {
    if (error.status === 404) throw new NotFoundError("模型配置不存在");
    if (error.status === 400) throw new BadRequestError(error.code, error.code);
    throw new BadRequestError("模型服务暂时不可用", "BYOK_GATEWAY_UNAVAILABLE");
  }
  throw error;
}

/**
 * 列出当前用户的 LLM 提供商配置。
 * GET /api/v1/users/me/llm-providers
 * 需登录。
 */
users.get("/me/llm-providers", authMiddleware, async (c) => {
  try {
    return c.json({
      data: await listUserLlmProviders(c.get("userId") as string),
    });
  } catch (error) {
    return mapLlmError(error);
  }
});

/**
 * 创建当前用户的 LLM 提供商配置。
 * POST /api/v1/users/me/llm-providers
 * 需登录；body 需提供 name、model、api_key（base_url 可选）。
 */
users.post("/me/llm-providers", authMiddleware, async (c) => {
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (!body.name || !body.model || !body.api_key) {
    throw new BadRequestError("缺少必填字段：name、model、api_key");
  }
  try {
    const data = await createUserLlmProvider(c.get("userId") as string, {
      name: String(body.name),
      base_url: String(body.base_url ?? "https://api.openai.com/v1"),
      model: String(body.model),
      api_key: String(body.api_key),
    });
    return c.json({ data }, 201);
  } catch (error) {
    return mapLlmError(error);
  }
});

/**
 * 更新当前用户的 LLM 提供商配置。
 * PUT /api/v1/users/me/llm-providers/:id
 * 需登录；body 为可选的 name/base_url/model/api_key 字段。
 */
users.put("/me/llm-providers/:id", authMiddleware, async (c) => {
  const body = await parseJsonBody<
    Partial<{ name: string; base_url: string; model: string; api_key: string }>
  >(c);
  try {
    const data = await updateUserLlmProvider(
      c.get("userId") as string,
      c.req.param("id") as string,
      body,
    );
    return c.json({ data });
  } catch (error) {
    return mapLlmError(error);
  }
});

/**
 * 删除当前用户的 LLM 提供商配置。
 * DELETE /api/v1/users/me/llm-providers/:id
 * 需登录；成功返回 204。
 */
users.delete("/me/llm-providers/:id", authMiddleware, async (c) => {
  try {
    await deleteUserLlmProvider(
      c.get("userId") as string,
      c.req.param("id") as string,
    );
    return c.body(null, 204);
  } catch (error) {
    return mapLlmError(error);
  }
});

/**
 * 测试当前用户的 LLM 提供商配置连通性。
 * POST /api/v1/users/me/llm-providers/:id/test
 * 需登录；成功返回 `{ data: { status: "ok" } }`。
 */
users.post("/me/llm-providers/:id/test", authMiddleware, async (c) => {
  try {
    await testUserLlmProvider(
      c.get("userId") as string,
      c.req.param("id") as string,
    );
    return c.json({ data: { status: "ok" } });
  } catch (error) {
    return mapLlmError(error);
  }
});

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
