/**
 * 管理员变更的共用保护。
 *
 * 角色变更、封禁与注销都可能减少“可用管理员”。三类操作必须共用同一把
 * 事务级锁，并在锁内重新读取状态，否则两个管理员并发互相降权/封禁/删除时
 * 会各自基于旧计数成功，最终没有任何可用管理员。
 *
 * 可用管理员口径：`users.role = 'admin'`，排除 root 系统账号、已注销账号
 * 与处于有效平台封禁中的账号（与 getAdminUserIds 一致）。
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { DbTx } from "../../shared/db/executor.ts";
import { userBans, users } from "../../shared/db/schema.ts";
import { ROOT_USER_ID } from "../../shared/base/constants.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../shared/base/errors.ts";
import {
  isPlatformRole,
  parsePlatformRole,
  type PlatformRole,
} from "../../shared/access/roles.ts";

/**
 * 管理员变更锁的 advisory lock key。
 *
 * 取 "NOJ2" 的十六进制；事务级锁（pg_advisory_xact_lock）随事务提交或回滚
 * 自动释放，不会泄漏到连接池。
 */
const ADMIN_MUTATION_LOCK_KEY = 0x4e4f4a32;

/** 在事务内取得管理员变更锁。 */
export async function lockAdminMutationsTx(tx: DbTx): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${ADMIN_MUTATION_LOCK_KEY})`,
  );
}

/** 统计当前可用管理员数量（可排除一个目标账号）。 */
export async function countAvailableAdminsTx(
  tx: DbTx,
  excludeUserId?: string,
): Promise<number> {
  const conditions = [
    eq(users.role, "admin"),
    isNull(users.deleted_at),
    ne(users.id, ROOT_USER_ID),
    sql`NOT EXISTS (
      SELECT 1 FROM user_bans admin_ban
      WHERE admin_ban.user_id = ${users.id}
        AND admin_ban.scope = 'platform'
        AND admin_ban.unbanned_at IS NULL
        AND (admin_ban.banned_until IS NULL OR admin_ban.banned_until > ${
      new Date().toISOString()
    })
    )`,
  ];
  if (excludeUserId) conditions.push(ne(users.id, excludeUserId));
  const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(
    users,
  ).where(and(...conditions));
  return Number(row?.count ?? 0);
}

/**
 * 事务内断言“至少还有一个可用管理员”，否则抛 409 LAST_ADMIN。
 *
 * 所有可能减少可用管理员的写入口（降权、平台封禁、注销）都必须在取得
 * 管理员变更锁之后调用它，不能用事务外的普通 SELECT 计数代替。
 */
export async function assertAvailableAdminRemainsTx(
  tx: DbTx,
  excludeUserId: string,
): Promise<void> {
  const remaining = await countAvailableAdminsTx(tx, excludeUserId);
  if (remaining < 1) {
    throw new ConflictError("至少保留一个可用管理员", "LAST_ADMIN");
  }
}

/**
 * 事务内断言操作者当前仍是可用的平台管理员。
 *
 * 调用方必须已经持有管理员变更锁：降权、封禁、注销都会改变这一判定，
 * 只有锁内重读才能保证已通过 HTTP 前置检查的请求不会用旧身份继续写入。
 */
export async function assertActiveAdminActorTx(
  tx: DbTx,
  actorId: string,
): Promise<void> {
  // root 是系统账号：不可登录、不可删除、不可封禁，作为受控系统操作者放行；
  // 它不计入“可用管理员”数量（见 countAvailableAdminsTx）。
  if (actorId === ROOT_USER_ID) return;
  const [account] = await tx.select({
    role: users.role,
    deleted_at: users.deleted_at,
  }).from(users).where(eq(users.id, actorId)).limit(1);
  if (!account || account.deleted_at || account.role !== "admin") {
    throw new ForbiddenError("需要管理员权限");
  }
  const now = new Date().toISOString();
  const [ban] = await tx.select({ id: userBans.id }).from(userBans).where(
    and(
      eq(userBans.user_id, actorId),
      eq(userBans.scope, "platform"),
      isNull(userBans.unbanned_at),
      sql`(${userBans.banned_until} IS NULL OR ${userBans.banned_until} > ${now})`,
    ),
  ).limit(1);
  if (ban) {
    throw new ForbiddenError("当前账号处于平台封禁中");
  }
}

/** 平台角色变更结果；包含旧值供审计记录真实的 from/to。 */
export interface PlatformRoleChangeResult {
  id: string;
  role: PlatformRole;
  previous_role: PlatformRole;
}

/**
 * 在调用方事务内设置单个平台角色。
 *
 * 拒绝修改自己、修改 root、目标不存在/已注销；降权时在锁内确认仍有至少
 * 一个可用管理员。相同角色重复设置是幂等的，不写审计、不递增版本。
 */
export async function setPlatformRoleTx(
  tx: DbTx,
  params: {
    actorId: string;
    targetUserId: string;
    role: unknown;
  },
): Promise<PlatformRoleChangeResult> {
  const role = parsePlatformRole(params.role);
  if (params.targetUserId === params.actorId) {
    throw new BadRequestError("不能修改自己的平台角色");
  }
  if (params.targetUserId === ROOT_USER_ID) {
    throw new BadRequestError("不能修改 root 用户的平台角色");
  }

  await lockAdminMutationsTx(tx);
  await assertActiveAdminActorTx(tx, params.actorId);

  const [target] = await tx.select({
    id: users.id,
    role: users.role,
    deleted_at: users.deleted_at,
  }).from(users).where(eq(users.id, params.targetUserId)).for("update");
  if (!target || target.deleted_at) {
    throw new NotFoundError("用户不存在");
  }
  const previousRole: PlatformRole = isPlatformRole(target.role)
    ? target.role
    : "user";
  if (previousRole === role) {
    return { id: target.id, role, previous_role: previousRole };
  }
  if (previousRole === "admin" && role === "user") {
    await assertAvailableAdminRemainsTx(tx, target.id);
  }
  await tx.update(users).set({
    role,
    updated_at: new Date().toISOString(),
  }).where(eq(users.id, target.id));
  return { id: target.id, role, previous_role: previousRole };
}

/** 事务内判断操作者当前是否仍是平台管理员。 */
export async function actorIsAdminTx(
  tx: DbTx,
  actorId: string,
): Promise<boolean> {
  const [account] = await tx.select({ role: users.role }).from(users).where(
    and(eq(users.id, actorId), isNull(users.deleted_at)),
  ).limit(1);
  return account?.role === "admin";
}
