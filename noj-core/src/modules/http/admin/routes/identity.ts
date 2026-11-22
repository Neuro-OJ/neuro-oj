/**
 * Admin identity 子域路由。
 *
 * 挂载前缀：/api/v1/admin/identity（由 domains/admin/index.ts 以 /identity 挂载）。
 * 合并原 identity 域两个管理路由文件：
 * - users（用户管理）
 * - blacklist（IP 黑名单管理）
 *
 * 审计分层：
 * - service 层已审计的操作（users.ban / users.unban / users.delete /
 *   ip_ban.create / ip_ban.delete）以 service 为唯一审计源，路由层不再重复写。
 * - 路由层 withAudit 仅补充原本未在 service 审计的写操作
 *   （users.role_change / users.create / users.import / users.reset_password /
 *   users.unlock_login）。
 * - 管理员开号与重置密码的审计绝不缓存含密码的请求体。
 */
import { MAX_SAFE_PAGE } from "../../../../shared/http/pagination.ts";
import { Hono } from "hono";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { AuthEnv } from "../../../access/identity/middleware/auth.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../../shared/http/request.ts";
import {
  BadRequestError,
  NotFoundError,
  ValidationError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import { listUsers } from "../../../access/identity/services/auth.ts";
import {
  adminUpdateUserProfile,
  banUser,
  getUserBanHistory,
  resolveUserId,
  unbanUser,
} from "../../../access/identity/services/users.ts";
import { setPlatformRole } from "../../../access/identity/services/admin-platform-role.ts";
import { adminDeleteAccount } from "../../../access/identity/services/account-deletion.ts";
import {
  addIpBan,
  listIpBans,
  removeIpBan,
} from "../../../access/identity/services/banlist.ts";
import { clearAllLoginFailures } from "../../../access/identity/services/security/loginThrottle.ts";
import { withAudit } from "../services/admin-audit.ts";
import type { AuditMeta } from "../types/admin-audit.ts";
import { adminVersionMiddleware } from "../middleware/admin-version.ts";
import {
  adminResetPassword,
  createAdminAccounts,
} from "../../../access/identity/services/admin-accounts.ts";

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
 * 管理员开号处理器：单建与批量导入共用校验、事务与审计。
 * 不受公开注册开关或邮件配置限制；审计只缓存白名单字段，绝不包含密码。
 */
function createAccountsHandler(bulk: boolean) {
  const operation = bulk ? "users.import" as const : "users.create" as const;
  return auditRoute({
    action: operation,
    target: (c) => ({
      type: "user",
      id: getAuditBody<{ ids: string[] }>(c)?.ids[0] ?? "",
    }),
    buildDetail: (c) => ({
      action: operation,
      ...getAuditBody<{ ids: string[]; usernames: string[]; role?: string }>(
        c,
      ),
    }),
  }, async (c) => {
    const body = await parseJsonBody<
      {
        users?: unknown;
        username?: unknown;
        email?: unknown;
        password?: unknown;
        role?: unknown;
      }
    >(c);
    assertObjectBody(body);
    const credentials = await createAdminAccounts(
      bulk ? body.users : [body],
      body.role,
    );
    setAuditBody(c, {
      ids: credentials.map((item) => item.id),
      usernames: credentials.map((item) => item.username),
      count: credentials.length,
      role: body.role ?? "user",
    });
    c.header("Cache-Control", "no-store");
    return c.json({ data: bulk ? credentials : credentials[0] }, 201);
  });
}

/** 管理员创建单个用户。POST /api/v1/admin/identity/users */
router.post("/users", createAccountsHandler(false));

/** 管理员批量导入用户（最多 500 行，整批事务）。POST /api/v1/admin/identity/users/import */
router.post("/users/import", createAccountsHandler(true));

router.post(
  "/users/:id/reset-password",
  auditRoute({
    action: "users.reset_password",
    target: (c) => ({
      type: "user",
      id: getAuditBody<{ id: string }>(c)?.id ?? "",
    }),
    buildDetail: (c) => ({
      action: "users.reset_password",
      user_id: getAuditBody<{ id: string }>(c)?.id,
    }),
  }, async (c) => {
    // 允许不带请求体，表示生成随机临时密码。
    const text = await c.req.text();
    let body: { password?: unknown } = {};
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new ValidationError("请求体必须为 JSON 对象");
      }
      if (
        !body || typeof body !== "object" || Array.isArray(body)
      ) throw new ValidationError("请求体必须为 JSON 对象");
    }
    const userId = await resolveUserId(c.req.param("id")!);
    const credential = await adminResetPassword(userId, body.password);
    setAuditBody(c, { id: credential.id });
    c.header("Cache-Control", "no-store");
    return c.json({ data: credential });
  }),
);

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
  // 超大 page 会让 OFFSET 超出 PG bigint（2026-09-21 修复）→ 回退默认页。
  if (page > MAX_SAFE_PAGE) page = 1;

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
 * 管理员修改用户平台角色（单值）。
 * PATCH /api/v1/admin/identity/users/:id/role
 * body: { role: "user" | "admin" }
 *
 * 拒绝修改自己/root、数组与未知角色；降权在事务级管理员锁内确认仍有
 * 可用管理员，两个管理员并发互相降权不会同时成功。
 */
router.patch(
  "/users/:id/role",
  auditRoute(
    {
      action: "users.role_change",
      target: (c) => ({
        type: "user",
        id: getAuditBody<{ id: string }>(c)?.id ?? c.req.param("id")!,
      }),
      buildDetail: (c) => {
        const body = getAuditBody<
          { id: string; role: string; previous_role: string }
        >(c);
        return {
          action: "users.role_change",
          from: body?.previous_role ?? "",
          to: body?.role ?? "",
        };
      },
    },
    async (c) => {
      const targetUserId = await resolveUserId(c.req.param("id")! as string);
      const body = await parseJsonBody<{ role?: unknown }>(c);
      assertObjectBody(body);
      const result = await setPlatformRole(
        c.get("userId"),
        targetUserId,
        body.role,
      );
      setAuditBody(c, {
        id: result.id,
        role: result.role,
        previous_role: result.previous_role,
      });
      return c.json({ data: { id: result.id, role: result.role } }, 200);
    },
  ),
);

/** 管理员解除该用户所有 IP、所有认证命名空间下的失败锁定。 */
router.post(
  "/users/:id/unlock-login",
  auditRoute(
    {
      action: "users.unlock_login",
      target: (c) => ({
        type: "user",
        id: getAuditBody<{ id: string }>(c)!.id,
      }),
      buildDetail: () => ({ action: "users.unlock_login" }),
    },
    async (c) => {
      const targetUserId = await resolveUserId(c.req.param("id")!);
      const [user] = await getDb().select({
        id: users.id,
        username: users.username,
      })
        .from(users).where(eq(users.id, targetUserId)).limit(1);
      if (!user) throw new NotFoundError("用户不存在");
      setAuditBody(c, { id: user.id });
      // 登录会解析为用户 ID；同时覆盖直接以用户名记录的失败条目。
      await clearAllLoginFailures(user.id);
      await clearAllLoginFailures(user.username);
      // 兼容旧 TFA 路径把可信用户 ID 当登录名再次解析后的标识。
      await clearAllLoginFailures(
        `unknown:${user.id.toLowerCase().slice(0, 64)}`,
      );
      return c.json({ data: { id: user.id, message: "已解除登录锁定" } });
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
  await adminDeleteAccount(targetUserId, c.get("actor"));
  return c.body(null, 204);
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
  // 超大 page 会让 OFFSET 超出 PG bigint（2026-09-21 修复）→ 回退默认页。
  if (page > MAX_SAFE_PAGE) page = 1;

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
