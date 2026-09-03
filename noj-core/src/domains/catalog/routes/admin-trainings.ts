/**
 * 题单后台管理路由（issue #224）。
 *
 * 挂载前缀：/api/v1/admin/trainings
 * 提供：全部题单列表、任意题单更新（含 public/pin）、删除。
 * 权限：细粒度 `training:*`；`admin:full_access` 通配放行。
 */

import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "../../../middleware/auth.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "./../../../shared/http/request.ts";
import { parsePagination } from "./../../../shared/http/pagination.ts";
import { assertPermission, checkPermission } from "../../../lib/permissions.ts";
import { withActorContext } from "../../../lib/requestContext.ts";
import {
  deleteTraining,
  listAllTrainings,
  resolveTrainingId,
  updateTraining,
} from "../services/trainings.ts";
import type { UpdateTrainingInput } from "../../../types/trainings.ts";

const router = new Hono<AuthEnv>();

/**
 * 组级中间件：认证 + RequestContext 注入；具体权限在各 handler 内按需校验。
 * 应用于本路由组全部路径。
 */
router.use("*", authMiddleware, (c, next) => {
  return withActorContext(c, () => next());
});

/**
 * 全部题单列表（含 private）。
 * GET /api/v1/admin/trainings?page=&per_page=
 * 需 training:read_any。
 */
router.get("/", async (c) => {
  await assertPermission(c, "training:read_any");
  const { page, perPage } = parsePagination(c);
  const result = await listAllTrainings({ page, perPage });
  return c.json({
    data: result.data,
    total: result.total,
    page,
    per_page: perPage,
  });
});

/**
 * 更新任意题单（含设为 public / 置顶）。
 * PATCH /api/v1/admin/trainings/:id
 * 需 training:write_any；设为 public 需 training:publish，置顶需 training:pin。
 * body: { title?, description?, visibility?, is_pinned? }。
 */
router.patch("/:id", async (c) => {
  const id = await resolveTrainingId(c.req.param("id") as string);
  const body = await parseJsonBody<UpdateTrainingInput>(c);
  assertObjectBody(body as unknown);
  const canPublish = await checkPermission(c, "training:publish");
  const canPin = await checkPermission(c, "training:pin");

  const editsTitleOrDescription = body.title !== undefined ||
    body.description !== undefined;
  const editsNonPublicVisibility = body.visibility !== undefined &&
    body.visibility !== "public";
  if (editsTitleOrDescription || editsNonPublicVisibility) {
    await assertPermission(c, "training:write_any");
  }
  if (body.visibility === "public") {
    await assertPermission(c, "training:publish");
  }
  if (body.is_pinned !== undefined) {
    await assertPermission(c, "training:pin");
  }

  const updated = await updateTraining(id, body, c.get("userId"), {
    isAdmin: true,
    canPublish,
    canPin,
  });
  return c.json({ data: updated });
});

/**
 * 删除任意题单。
 * DELETE /api/v1/admin/trainings/:id
 * 需 training:delete_any；响应 204。
 */
router.delete("/:id", async (c) => {
  await assertPermission(c, "training:delete_any");
  const id = await resolveTrainingId(c.req.param("id") as string);
  await deleteTraining(id, c.get("userId"), true);
  return c.body(null, 204);
});

export default router;
