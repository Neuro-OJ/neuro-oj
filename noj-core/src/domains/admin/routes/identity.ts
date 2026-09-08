/**
 * Admin identity 子域路由。
 *
 * 挂载前缀：/api/v1/admin/identity（由 domains/admin/index.ts 以 /identity 挂载）。
 * 合并原 identity 域三个管理路由文件：
 * - users（用户管理）
 * - roles/permissions（RBAC 管理）
 * - blacklist（IP 黑名单管理）
 *
 * 审计分层：
 * - service 层已审计的操作（users.ban / users.unban / users.delete /
 *   ip_ban.create / ip_ban.delete）以 service 为唯一审计源，路由层不再重复写。
 * - 路由层 withAudit 仅补充原本未在 service 审计的写操作
 *   （users.role_change / roles.create / roles.update / roles.delete）。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { AuthEnv } from "../../identity/middleware/auth.ts";
import { parseJsonBody } from "../../../shared/http/request.ts";
import {
  BadRequestError,
  ValidationError,
} from "../../../shared/base/errors.ts";
import { getDb } from "../../../shared/db/connection.ts";
import { users } from "../../../shared/db/schema.ts";
import { listUsers } from "../../identity/services/auth.ts";
import {
  adminUpdateUserProfile,
  banUser,
  getUserBanHistory,
  resolveUserId,
  unbanUser,
} from "../../identity/services/users.ts";
import {
  createRole,
  deleteRole,
  listPermissions,
  listRoles,
  updateRole,
  updateUserRoles,
} from "../../identity/services/admin-roles.ts";
import { adminDeleteAccount } from "../../identity/services/account-deletion.ts";
import {
  addIpBan,
  listIpBans,
  removeIpBan,
} from "../../identity/services/banlist.ts";
import { withAudit } from "../services/admin-audit.ts";
import type { AuditMeta } from "../types/admin-audit.ts";
import { adminVersionMiddleware } from "../middleware/admin-version.ts";

/** 路由层审计用的临时请求体缓存（withAudit 在 handler 返回后才构建 detail）。 */
const auditBodies = new WeakMap<object, unknown>();

function setAuditBody(c: object, body: unknown): void {
  auditBodies.set(c, body);
}

function getAuditBody<T>(c: object): T | undefined {
  return auditBodies.get(c) as T | undefined;
}

/** 将 AuthEnv handler 适配为 withAudit 接受的 Context handler。 */
function auditRoute(
  meta: AuditMeta,
  handler: (c: Context<AuthEnv>) => Promise<Response>,
) {
  return withAudit(meta)(handler as (c: Context) => Promise<Response>);
}

const router = new Hono<AuthEnv>();

/**
 * 管理员获取用户列表（分页 + 搜索筛选）。
 * GET /api/v1/admin/identity/users
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
 * PATCH /api/v1/admin/identity/users/:id/role
 *
 * **BREAKING**: 旧格式 `{ "role": "admin"|"user" }` 不再接受。
 * 新格式: `{ "role_ids": ["<uuid>", ...] }`
 */
router.patch(
  "/users/:id/role",
  auditRoute(
    {
      action: "users.role_change",
      target: (c) => ({ type: "user", id: c.req.param("id")! }),
      buildDetail: (c) => {
        const body = getAuditBody<{ role_ids: string[] }>(c);
        return {
          action: "users.role_change",
          from: "unknown",
          to: body?.role_ids?.join(",") ?? "",
        };
      },
    },
    async (c) => {
      const body = await parseJsonBody<{ role_ids: string[] }>(c);
      setAuditBody(c, body);

      if (!body.role_ids || !Array.isArray(body.role_ids)) {
        throw new ValidationError("缺少必填字段：role_ids（UUID 数组）");
      }

      const targetUserId = await resolveUserId(c.req.param("id")! as string);
      await updateUserRoles(targetUserId, body.role_ids, c.get("userId"));

      // 返回更新结果
      return c.json(
        { data: { id: targetUserId, role_ids: body.role_ids } },
        200,
      );
    },
  ),
);

/**
 * 管理员编辑用户资料。
 * PUT /api/v1/admin/identity/users/:id
 */
router.put(
  "/users/:id",
  adminVersionMiddleware(async (c) => {
    const targetUserId = await resolveUserId(c.req.param("id")! as string);
    const rows = await getDb().select({ updated_at: users.updated_at })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);
    return rows[0]?.updated_at;
  }),
  async (c) => {
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

    const targetUserId = await resolveUserId(c.req.param("id")! as string);
    const user = await adminUpdateUserProfile(targetUserId, body);
    return c.json({ data: user }, 200);
  },
);

/**
 * 管理员封禁用户。
 * PATCH /api/v1/admin/identity/users/:id/ban
 * body: { reason?, banned_until? }
 */
router.patch("/users/:id/ban", async (c) => {
  const targetUserId = await resolveUserId(c.req.param("id")! as string);
  const body = await parseJsonBody<{
    reason?: string;
    banned_until?: string | null;
    scope?: "platform" | "social";
  }>(c);
  const user = await banUser(
    targetUserId,
    body.reason,
    body.banned_until,
    c.get("userId"),
    body.scope ?? "platform",
  );
  return c.json({ data: user }, 200);
});

/**
 * 管理员解封用户。
 * PATCH /api/v1/admin/identity/users/:id/unban
 */
router.patch(
  "/users/:id/unban",
  adminVersionMiddleware(async (c) => {
    const targetUserId = await resolveUserId(c.req.param("id")! as string);
    const records = await getUserBanHistory(targetUserId);
    return records.find((r) => !r.unbanned_at)?.updated_at;
  }),
  async (c) => {
    const targetUserId = await resolveUserId(c.req.param("id")! as string);
    const user = await unbanUser(targetUserId, c.get("userId"));
    return c.json({ data: user }, 200);
  },
);

/**
 * 获取用户封禁历史（user-ban-table）。
 * GET /api/v1/admin/identity/users/:id/bans
 */
router.get("/users/:id/bans", async (c) => {
  const targetUserId = await resolveUserId(c.req.param("id")! as string);
  const records = await getUserBanHistory(targetUserId);
  return c.json({ data: records }, 200);
});

/** 管理员注销用户；固定确认词降低误操作风险。 */
router.delete("/users/:id", async (c) => {
  const body = await parseJsonBody<{ confirmation?: string }>(c);
  if (body.confirmation !== "DELETE") {
    throw new ValidationError("请输入确认词 DELETE");
  }
  const targetUserId = await resolveUserId(c.req.param("id")! as string);
  await adminDeleteAccount(targetUserId, c.get("userId"));
  return c.body(null, 204);
});

/**
 * 管理员获取角色列表。
 * GET /api/v1/admin/identity/roles
 */
router.get("/roles", async (c) => {
  const result = await listRoles();
  return c.json({ data: result });
});

/**
 * 管理员创建角色。
 * POST /api/v1/admin/identity/roles
 * body: { name, description?, parent_id?, permission_ids? }
 */
router.post(
  "/roles",
  auditRoute(
    {
      action: "roles.create",
      target: (c) => ({
        type: "role",
        id: getAuditBody<{ id?: string }>(c)?.id ?? "",
      }),
      buildDetail: (c) => {
        const body = getAuditBody<{
          name?: string;
          permission_ids?: string[];
        }>(c);
        return {
          action: "roles.create",
          name: body?.name ?? "",
          permission_ids: body?.permission_ids,
        };
      },
    },
    async (c) => {
      const body = await parseJsonBody<{
        name: string;
        description?: string;
        parent_id?: string;
        permission_ids?: string[];
      }>(c);
      setAuditBody(c, body);
      const result = await createRole(body);
      setAuditBody(c, { ...body, id: result.id });
      return c.json({ data: result }, 201);
    },
  ),
);

/**
 * 管理员编辑角色。
 * PUT /api/v1/admin/identity/roles/:id
 * body: { name?, description?, parent_id?, permission_ids? }
 */
router.put(
  "/roles/:id",
  adminVersionMiddleware(async (c) => {
    const id = c.req.param("id")! as string;
    return (await listRoles()).find((r) => r.id === id)?.updated_at;
  }),
  auditRoute(
    {
      action: "roles.update",
      target: (c) => ({ type: "role", id: c.req.param("id")! }),
      buildDetail: (c) => {
        const body = getAuditBody<{ name?: string }>(c);
        return {
          action: "roles.update",
          id: c.req.param("id")!,
          name: body?.name,
        };
      },
    },
    async (c) => {
      const id = c.req.param("id")! as string;
      const body = await parseJsonBody<{
        name?: string;
        description?: string;
        parent_id?: string | null;
        permission_ids?: string[];
      }>(c);
      setAuditBody(c, body);
      const result = await updateRole(id, body);
      return c.json({ data: result });
    },
  ),
);

/**
 * 管理员删除角色。
 * DELETE /api/v1/admin/identity/roles/:id
 */
router.delete(
  "/roles/:id",
  adminVersionMiddleware(async (c) => {
    const id = c.req.param("id")! as string;
    return (await listRoles()).find((r) => r.id === id)?.updated_at;
  }),
  auditRoute(
    {
      action: "roles.delete",
      target: (c) => ({ type: "role", id: c.req.param("id")! }),
      buildDetail: (c) => ({
        action: "roles.delete",
        id: c.req.param("id")!,
      }),
    },
    async (c) => {
      const id = c.req.param("id")! as string;
      await deleteRole(id);
      return c.body(null, 204);
    },
  ),
);

/**
 * 管理员获取权限列表（按 resource 分组）。
 * GET /api/v1/admin/identity/permissions
 */
router.get("/permissions", async (c) => {
  const result = await listPermissions();
  return c.json({ data: result });
});

/**
 * 管理员列出 IP 黑名单（分页 + 模糊搜索）。
 * GET /api/v1/admin/identity/blacklist?page=&per_page=&keyword=
 */
router.get("/blacklist", async (c) => {
  let page = parseInt(c.req.query("page") ?? "1", 10);
  let perPage = parseInt(c.req.query("per_page") ?? "20", 10);
  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(perPage) || perPage < 1) perPage = 20;
  if (perPage > 100) perPage = 100;

  const keyword = c.req.query("keyword") || undefined;
  const result = await listIpBans({ page, perPage, keyword });
  return c.json({ data: result.data, pagination: result.pagination });
});

/**
 * 管理员添加 IP 黑名单。
 * POST /api/v1/admin/identity/blacklist
 * body: { ip_or_cidr, reason?, expires_at? }
 */
router.post("/blacklist", async (c) => {
  const body = await parseJsonBody<{
    ip_or_cidr: string;
    reason?: string;
    expires_at?: string | null;
  }>(c);
  if (!body.ip_or_cidr) {
    throw new ValidationError("缺少必填字段：ip_or_cidr");
  }
  const ban = await addIpBan(body, c.get("userId"));
  return c.json({ data: ban }, 201);
});

/**
 * 管理员删除 IP 黑名单条目。
 * DELETE /api/v1/admin/identity/blacklist/:id
 */
router.delete(
  "/blacklist/:id",
  adminVersionMiddleware(async (c) => {
    const id = c.req.param("id")! as string;
    const res = await listIpBans({ page: 1, perPage: 100 });
    return res.data.find((b) => b.id === id)?.updated_at;
  }),
  async (c) => {
    const id = c.req.param("id")! as string;
    await removeIpBan(id, c.get("userId"));
    return c.body(null, 204);
  },
);

export default router;
