import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "../../../middleware/auth.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import { ValidationError } from "./../../../shared/base/errors.ts";
import { requirePermission } from "../../../lib/permissions.ts";
import { withActorContext } from "../../../lib/requestContext.ts";
import {
  createTag,
  type CreateTagInput,
  deleteTag,
  listTags,
  mergeTags,
  updateTag,
  type UpdateTagInput,
} from "../services/tags.ts";

const router = new Hono<AuthEnv>();

/**
 * 获取全部标签（公开，含算法标签名——洛谷式发现路径）。
 * GET /api/v1/tags
 */
router.get("/", async (c) => {
  const data = await listTags();
  return c.json({ data });
});

/**
 * 创建标签（tag:manage 权限：默认仅 admin，可经角色授权配置）。
 * POST /api/v1/tags
 */
router.post(
  "/",
  authMiddleware,
  requirePermission("tag:manage"),
  async (c) => {
    const body = await parseJsonBody<CreateTagInput>(c);
    if (!body.name || !body.kind) {
      throw new ValidationError("缺少必填字段：name, kind");
    }
    return withActorContext(c, async () => {
      const tag = await createTag(body);
      return c.json({ data: tag }, 201);
    });
  },
);

/**
 * 更新标签（改名 / 改 kind，tag:manage 权限）。
 * PUT /api/v1/tags/:id
 */
router.put(
  "/:id",
  authMiddleware,
  requirePermission("tag:manage"),
  async (c) => {
    const id = c.req.param("id") as string;
    const body = await parseJsonBody<UpdateTagInput>(c);
    return withActorContext(c, async () => {
      const tag = await updateTag(id, body);
      return c.json({ data: tag });
    });
  },
);

/**
 * 删除标签（tag:manage 权限；级联清理关联）。
 * DELETE /api/v1/tags/:id
 */
router.delete(
  "/:id",
  authMiddleware,
  requirePermission("tag:manage"),
  (c) => {
    const id = c.req.param("id") as string;
    return withActorContext(c, async () => {
      await deleteTag(id);
      return c.body(null, 204);
    });
  },
);

/**
 * 合并标签（tag:manage 权限）：source 关联重指向 target 后删除 source。
 * POST /api/v1/tags/:id/merge
 */
router.post(
  "/:id/merge",
  authMiddleware,
  requirePermission("tag:manage"),
  async (c) => {
    const id = c.req.param("id") as string;
    const body = await parseJsonBody<{ target_id?: string }>(c);
    if (!body.target_id) {
      throw new ValidationError("缺少必填字段：target_id");
    }
    return withActorContext(c, async () => {
      await mergeTags(id, body.target_id as string);
      return c.body(null, 204);
    });
  },
);

export default router;
