import { Hono } from "hono";
import type { AuthEnv } from "../../middleware/auth.ts";
import { parseJsonBody } from "../../lib/request.ts";
import { BadRequestError, ValidationError } from "../../lib/errors.ts";
import { listUsers } from "../../services/auth.ts";
import {
  adminUpdateUserProfile,
  banUser,
  getUserBanHistory,
  resolveUserId,
  unbanUser,
} from "../../services/users.ts";
import { updateUserRoles } from "../../services/admin-roles.ts";

/**
 * 管理端用户管理路由（挂载前缀 /api/v1/admin，见 admin/index.ts）。
 *
 * 提供：
 * - GET    /users                    用户列表（分页 + 筛选）
 * - PUT    /users/:id                编辑用户资料（email/bio）
 * - PATCH  /users/:id/role           修改角色分配（role_ids 格式）
 * - PATCH  /users/:id/ban            封禁用户
 * - PATCH  /users/:id/unban          解封用户
 * - GET    /users/:id/bans           用户封禁历史
 */
const router = new Hono<AuthEnv>();

/**
 * 管理员获取用户列表（分页 + 搜索筛选）。
 * GET /api/v1/admin/users
 */
router.get("/users", async (c) => {
  let page = parseInt(c.req.query("page") ?? "1", 10);
  let perPage = parseInt(c.req.query("per_page") ?? "20", 10);
  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(perPage) || perPage < 1) perPage = 20;
  if (perPage > 100) perPage = 100;

  const keyword = c.req.query("keyword") || undefined;
  // is_admin 筛选：true / false / 缺省（全部）
  const isAdminParam = c.req.query("is_admin");
  const isAdmin = isAdminParam === "true"
    ? true
    : isAdminParam === "false"
    ? false
    : undefined;
  const from = c.req.query("from") || undefined;
  const to = c.req.query("to") || undefined;

  const result = await listUsers({ page, perPage, keyword, isAdmin, from, to });
  return c.json({ data: result.data, pagination: result.pagination });
});

/**
 * 管理员修改用户角色分配。
 * PATCH /api/v1/admin/users/:id/role
 *
 * **BREAKING**: 旧格式 `{ "role": "admin"|"user" }` 不再接受。
 * 新格式: `{ "role_ids": ["<uuid>", ...] }`
 */
router.patch("/users/:id/role", async (c) => {
  const body = await parseJsonBody<{ role_ids: string[] }>(c);

  if (!body.role_ids || !Array.isArray(body.role_ids)) {
    throw new ValidationError("缺少必填字段：role_ids（UUID 数组）");
  }

  const targetUserId = await resolveUserId(c.req.param("id") as string);
  await updateUserRoles(targetUserId, body.role_ids, c.get("userId"));

  // 返回更新结果
  return c.json({ data: { id: targetUserId, role_ids: body.role_ids } }, 200);
});

/**
 * 管理员编辑用户资料。
 * PUT /api/v1/admin/users/:id
 */
router.put("/users/:id", async (c) => {
  const body = await parseJsonBody<{ email?: string; bio?: string }>(c);

  if (body.email === undefined && body.bio === undefined) {
    throw new BadRequestError("至少需要提供一个可更新字段（email 或 bio）");
  }

  if (
    body.email !== undefined &&
    !/^(?!\.)(?!.*\.\.)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(
      body.email,
    )
  ) {
    throw new BadRequestError("邮箱格式不正确");
  }

  const targetUserId = await resolveUserId(c.req.param("id") as string);
  const user = await adminUpdateUserProfile(targetUserId, body);
  return c.json({ data: user }, 200);
});

/**
 * 管理员封禁用户。
 * PATCH /api/v1/admin/users/:id/ban
 * body: { reason?, banned_until? }
 */
router.patch("/users/:id/ban", async (c) => {
  const targetUserId = await resolveUserId(c.req.param("id") as string);
  const body = await parseJsonBody<{
    reason?: string;
    banned_until?: string | null;
  }>(c);
  const user = await banUser(
    targetUserId,
    body.reason,
    body.banned_until,
    c.get("userId"),
  );
  return c.json({ data: user }, 200);
});

/**
 * 管理员解封用户。
 * PATCH /api/v1/admin/users/:id/unban
 */
router.patch("/users/:id/unban", async (c) => {
  const targetUserId = await resolveUserId(c.req.param("id") as string);
  const user = await unbanUser(targetUserId, c.get("userId"));
  return c.json({ data: user }, 200);
});

/**
 * 获取用户封禁历史（user-ban-table）。
 * GET /api/v1/admin/users/:id/bans
 */
router.get("/users/:id/bans", async (c) => {
  const targetUserId = await resolveUserId(c.req.param("id") as string);
  const records = await getUserBanHistory(targetUserId);
  return c.json({ data: records }, 200);
});

export default router;
