import { Hono } from "hono";
import { authMiddleware } from "../../modules/access/index.ts";
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
 * 标签审计上下文：保持迁移前行为——原实现调用 `logAudit`，以系统身份（actor=null，
 * IP "system"）记录，不读取请求主体。
 *
 * 已知问题（另行修复，不在本次结构迁移中改变行为）：默认审计列表排除系统账号，
 * 标签管理操作因此不可见；修复时应改为记录真实管理员，IP 必须用 `getClientIp`。
 */
export const TAG_AUDIT_CONTEXT: TagWriteContext = {
  actor: null,
  auditMeta: { ipAddress: "system" },
};

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
    const tag = await createTag(TAG_AUDIT_CONTEXT, body);
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
    const tag = await updateTag(TAG_AUDIT_CONTEXT, c.req.param("id"), body);
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
    await deleteTag(TAG_AUDIT_CONTEXT, c.req.param("id"));
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
    await mergeTags(TAG_AUDIT_CONTEXT, c.req.param("id"), body.target_id);
    return c.body(null, 204);
  },
);
