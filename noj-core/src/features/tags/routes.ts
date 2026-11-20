import { Hono } from "hono";
import type { Context } from "hono";
import {
  authMiddleware,
  userActorFromAuthenticatedId,
} from "../../modules/access/index.ts";
import { getClientIp } from "../../modules/platform/index.ts";
import { requirePermission } from "../../modules/access/contracts/cross-module/identity_services_security_permissions.ts";
import { type AuthEnv } from "../../shared/http/hono-env.ts";
import { parseJsonBody } from "../../shared/http/request.ts";
import { ValidationError } from "../../shared/base/errors.ts";
import {
  createTag,
  type CreateTagInput,
  deleteTag,
  listTags,
  mergeTags,
  type TagResponse,
  type TagWriteContext,
  updateTag,
  type UpdateTagInput,
} from "./service.ts";

/**
 * 从请求构造标签审计上下文：操作人为已认证用户，IP 用 `getClientIp`
 * （遵循 TRUSTED_PROXIES，不能直接读可伪造的 `X-Forwarded-For`）。
 */
export function tagWriteContext(c: Context<AuthEnv>): TagWriteContext {
  return {
    actor: userActorFromAuthenticatedId(c.var.userId),
    auditMeta: { ipAddress: getClientIp(c) },
  };
}

/** 标签管理路由，挂在 `/api/v1` 下（原 `catalogRouter.route("/tags", …)`）。 */
export const tagsRouter = new Hono<AuthEnv>();
const prefix = "/tags";

/**
 * 获取全部标签（公开，含算法标签名——洛谷式发现路径）。
 * GET /api/v1/tags
 */
tagsRouter.get(prefix, async (c) => {
  const data: TagResponse[] = await listTags();
  return c.json({ data });
});

/**
 * 创建标签（tag:manage 权限：默认仅 admin，可经角色授权配置）。
 * POST /api/v1/tags
 */
tagsRouter.post(
  prefix,
  authMiddleware,
  requirePermission("tag:manage"),
  async (c) => {
    const body = await parseJsonBody<CreateTagInput>(c);
    if (!body.name || !body.kind) {
      throw new ValidationError("缺少必填字段：name, kind");
    }
    const tag = await createTag(tagWriteContext(c), body);
    return c.json({ data: tag }, 201);
  },
);

/**
 * 更新标签（改名 / 改 kind，tag:manage 权限）。
 * PUT /api/v1/tags/:id
 */
tagsRouter.put(
  `${prefix}/:id`,
  authMiddleware,
  requirePermission("tag:manage"),
  async (c) => {
    const body = await parseJsonBody<UpdateTagInput>(c);
    const tag = await updateTag(tagWriteContext(c), c.req.param("id"), body);
    return c.json({ data: tag });
  },
);

/**
 * 删除标签（tag:manage 权限；级联清理关联）。
 * DELETE /api/v1/tags/:id
 */
tagsRouter.delete(
  `${prefix}/:id`,
  authMiddleware,
  requirePermission("tag:manage"),
  async (c) => {
    await deleteTag(tagWriteContext(c), c.req.param("id"));
    return c.body(null, 204);
  },
);

/**
 * 合并标签（tag:manage 权限）：source 关联重指向 target 后删除 source。
 * POST /api/v1/tags/:id/merge
 */
tagsRouter.post(
  `${prefix}/:id/merge`,
  authMiddleware,
  requirePermission("tag:manage"),
  async (c) => {
    const body = await parseJsonBody<{ target_id?: string }>(c);
    if (!body.target_id) {
      throw new ValidationError("缺少必填字段：target_id");
    }
    await mergeTags(tagWriteContext(c), c.req.param("id"), body.target_id);
    return c.body(null, 204);
  },
);
