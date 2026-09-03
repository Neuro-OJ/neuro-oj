/**
 * 公告管理路由（issue #231）。
 *
 * 提供（挂载前缀 /api/v1/admin/announcements，见 app.ts）：
 * - GET /api/v1/admin/announcements：全量列表（含未发布/已下架），分页 + 可选 is_active 筛选
 * - POST /api/v1/admin/announcements：创建公告
 * - PUT /api/v1/admin/announcements/:id：更新公告（部分更新；发布/下架 = 更新 is_active）
 * - DELETE /api/v1/admin/announcements/:id：物理删除
 *
 * 权限模型（与主 admin 路由不同）：
 * 主 admin 路由（routes/admin.ts）组级挂载 adminMiddleware，仅放行持有
 * `admin:full_access` 的用户；公告管理采用细粒度权限 `announcement:manage`，
 * 持有 `admin:full_access`（通配放行）**或显式拥有** `announcement:manage`
 * 的用户均可放行（spec: admin-authorization / announcement-management）。
 * 因此本实例不挂 adminMiddleware，改用细粒度中间件：
 * `assertPermission(c, "announcement:manage")` + `runWithContext` 注入
 * RequestContext（与 adminMiddleware 同款，供 service 层 logAudit /
 * created_by 使用）。
 */

import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "./../../identity/index.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import { assertPermission } from "./../../identity/index.ts";
import { withActorContext } from "../../../lib/requestContext.ts";
import { parsePagination } from "./../../../shared/http/pagination.ts";
import {
  createAnnouncement,
  deleteAnnouncement,
  listAdminAnnouncements,
  resolveAnnouncementId,
  updateAnnouncement,
} from "../services/announcements.ts";
import type {
  CreateAnnouncementInput,
  UpdateAnnouncementInput,
} from "../services/announcements.ts";

const router = new Hono<AuthEnv>();

// 组级中间件：认证 + 细粒度权限（admin:full_access 通配放行 或
// announcement:manage）+ RequestContext 注入（审计日志埋点）。
/**
 * 公告管理路由组级中间件。
 * USE *（所有子路径）。
 *
 * 流程：先经 authMiddleware 完成认证，再校验细粒度权限
 * （admin:full_access 通配放行或显式持有 announcement:manage），
 * 最后以 withActorContext 注入 actorId/actorIp/actorRole 的 RequestContext，
 * 供 service 层审计日志与 created_by 使用。
 *
 * 认证/权限：必须登录（authMiddleware）；权限不足返回 403。
 * 响应：通过后调用 next() 继续处理；失败以 Hono 默认错误响应返回。
 */
router.use("*", authMiddleware, async (c, next) => {
  await assertPermission(c, "announcement:manage");
  return withActorContext(c, () => next());
});

/**
 * 管理员获取公告列表（含未发布/已下架）。
 * GET /api/v1/admin/announcements?page=1&per_page=20&is_active=true
 * is_active 筛选可选：true / false / 缺省（全部）。
 */
router.get("/", async (c) => {
  await assertPermission(c, "announcement:manage");
  const { page, perPage } = parsePagination(c);
  const isActiveParam = c.req.query("is_active");
  const isActive = isActiveParam === "true"
    ? true
    : isActiveParam === "false"
    ? false
    : undefined;
  const result = await listAdminAnnouncements(page, perPage, isActive);
  return c.json(result);
});

/**
 * 管理员创建公告。
 * POST /api/v1/admin/announcements
 * body: { title, content, is_pinned?, is_active? }
 */
router.post("/", async (c) => {
  await assertPermission(c, "announcement:manage");
  const body = await parseJsonBody<CreateAnnouncementInput>(c);
  const item = await createAnnouncement(body);
  return c.json({ data: item }, 201);
});

/**
 * 管理员更新公告（部分更新语义；发布/下架 = 更新 is_active）。
 * PUT /api/v1/admin/announcements/:id
 */
router.put("/:id", async (c) => {
  await assertPermission(c, "announcement:manage");
  const id = await resolveAnnouncementId(c.req.param("id") as string);
  const body = await parseJsonBody<UpdateAnnouncementInput>(c);
  const item = await updateAnnouncement(id, body);
  return c.json({ data: item });
});

/**
 * 管理员删除公告。
 * DELETE /api/v1/admin/announcements/:id
 */
router.delete("/:id", async (c) => {
  await assertPermission(c, "announcement:manage");
  const id = await resolveAnnouncementId(c.req.param("id") as string);
  await deleteAnnouncement(id);
  return c.body(null, 204);
});

export default router;
