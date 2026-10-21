/** access 的账户注销本地事实；跨 assets/search/legal 副作用由 application 编排。 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DbRoot, DbTx } from "../../shared/db/executor.ts";
import { getDb } from "../../shared/db/connection.ts";
import {
  auditLogs,
  oauthAccounts,
  passwordResetTokens,
  tfaRecoveryCodes,
  userBans,
  userRoles,
  users,
} from "../../shared/db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../../shared/base/errors.ts";
import { ROOT_USER_ID } from "../../shared/base/constants.ts";
import { comparePassword } from "./identity/services/security/password.ts";
import {
  getAdminUserIds,
  getUserPermissions,
} from "./identity/services/security/permissions.ts";
import type { UserActor } from "./contracts/actor.ts";
import { requireUserActor } from "./contracts/actor.ts";
import {
  assertAccountHasNoOwnedDomainTx,
  type MemberRemovalBoundary,
  retireAccountWorkspaceMembershipsTx,
} from "./members.ts";
import type { AccessWriteMeta } from "./members.ts";

export interface AccountLifecycleBoundary extends MemberRemovalBoundary {
  /** 提交后通知搜索/read-model；失败不回滚已提交账户事实。 */
  readonly afterCommit: (event: {
    type: "account_deleted";
    userId: string;
    previousAvatarUrl: string | null;
  }) => Promise<void>;
}

async function anonymizeUserTx(
  tx: DbTx,
  targetUserId: string,
  actor: UserActor,
  expectedPasswordHash: string | undefined,
  meta: AccessWriteMeta = {},
  boundary: MemberRemovalBoundary,
): Promise<{ username: string; avatarUrl: string | null }> {
  const operationActor = requireUserActor(actor);
  if (targetUserId === ROOT_USER_ID) {
    throw new ForbiddenError("系统 root 账户不可注销");
  }
  const [existing] = await tx.select().from(users).where(
    eq(users.id, targetUserId),
  ).for("update");
  if (!existing || existing.deleted_at) throw new NotFoundError("用户不存在");
  if (
    expectedPasswordHash && existing.password_hash !== expectedPasswordHash
  ) throw new UnauthorizedError("密码已变化，请重新确认", "PASSWORD_INVALID");
  await assertAccountHasNoOwnedDomainTx(tx, targetUserId);
  await retireAccountWorkspaceMembershipsTx(
    tx,
    operationActor,
    targetUserId,
    meta,
    boundary,
  );
  const now = new Date().toISOString();
  await tx.update(users).set({
    username: "已注销用户",
    email: `deleted-${targetUserId}@deleted.invalid`,
    password_hash: null,
    bio: "",
    avatar_url: null,
    must_change_password: false,
    email_verified: true,
    email_verify_token: null,
    email_verify_expires_at: null,
    tfa_secret_encrypted: null,
    tfa_enabled: false,
    deleted_at: now,
    updated_at: now,
  }).where(eq(users.id, targetUserId));
  await tx.insert(auditLogs).values({
    id: crypto.randomUUID(),
    admin_id: operationActor.userId,
    action: "users.delete",
    target_type: "user",
    target_id: targetUserId,
    detail: {
      action: "users.delete",
      username: existing.username,
    },
    ip_address: meta.ipAddress ?? "",
    created_at: now,
  });
  await tx.delete(oauthAccounts).where(eq(oauthAccounts.user_id, targetUserId));
  await tx.delete(passwordResetTokens).where(
    eq(passwordResetTokens.user_id, targetUserId),
  );
  await tx.delete(tfaRecoveryCodes).where(
    eq(tfaRecoveryCodes.user_id, targetUserId),
  );
  await tx.delete(userRoles).where(eq(userRoles.user_id, targetUserId));
  await tx.update(userBans).set({
    unbanned_at: now,
    unbanned_by: operationActor.userId,
    updated_at: now,
  }).where(and(
    eq(userBans.user_id, targetUserId),
    isNull(userBans.unbanned_at),
  ));
  return { username: existing.username, avatarUrl: existing.avatar_url };
}

/** 用户自助注销的本地事务步骤；application 负责开启外层事务。 */
export function deleteOwnAccountTx(
  tx: DbTx,
  actor: UserActor,
  expectedPasswordHash: string,
  options: AccountLifecycleBoundary & { meta?: AccessWriteMeta },
): Promise<{ username: string; avatarUrl: string | null }> {
  const user = requireUserActor(actor);
  return anonymizeUserTx(
    tx,
    user.userId,
    user,
    expectedPasswordHash,
    options.meta,
    options,
  );
}

/** application 在开启本地事务前完成密码证明；返回值仅用于同一命令的锁内复核。 */
export async function verifyOwnAccountPassword(
  actor: UserActor,
  password: string,
): Promise<string> {
  const user = requireUserActor(actor);
  if (!password) throw new BadRequestError("请输入当前密码");
  const db: DbRoot = getDb();
  const [current] = await db.select().from(users).where(
    eq(users.id, user.userId),
  ).limit(1);
  if (!current?.password_hash) {
    throw new BadRequestError("请先设置本地密码再注销账户");
  }
  if (!await comparePassword(password, current.password_hash)) {
    throw new UnauthorizedError("密码不正确", "PASSWORD_INVALID");
  }
  return current.password_hash;
}

/** 管理员注销的本地事务步骤；application 负责开启外层事务。 */
export async function adminDeleteAccountTx(
  tx: DbTx,
  actor: UserActor,
  targetUserId: string,
  options: AccountLifecycleBoundary & { meta?: AccessWriteMeta },
): Promise<{ username: string; avatarUrl: string | null }> {
  const operationActor = requireUserActor(actor);
  if (operationActor.userId === targetUserId) {
    throw new BadRequestError(
      "管理员不能从后台注销自己，请使用个人设置中的注销入口",
    );
  }
  // 先收集当前管理员集合，再按稳定 ID 顺序锁住 actor、target 和所有
  // 管理员账号。两个管理员并发互删时必须在同一行锁队列中重新核对集合，
  // 不能只依赖普通 SELECT 的快照计数。
  const observedAdminIds = await getAdminUserIds(tx);
  const lockIds = [
    ...new Set([
      ...observedAdminIds,
      operationActor.userId,
      targetUserId,
    ]),
  ].sort();
  const lockedAccounts = await tx.select({
    id: users.id,
    deletedAt: users.deleted_at,
  }).from(users).where(inArray(users.id, lockIds)).orderBy(users.id).for(
    "update",
  );
  const activeAccounts = new Set(
    lockedAccounts.filter((account) => !account.deletedAt).map((account) =>
      account.id
    ),
  );
  if (!activeAccounts.has(operationActor.userId)) {
    throw new ForbiddenError("当前管理员账号已注销");
  }
  const permissions = await getUserPermissions(operationActor.userId, tx);
  if (!permissions.has("admin:full_access")) {
    throw new ForbiddenError("需要管理员权限");
  }
  // 账户行锁取得后重新读取角色集合；A 提交删除/角色变化后，B 不能继续
  // 使用事务开始时的普通 SELECT 快照决定最后管理员保护。
  const currentAdminIds = await getAdminUserIds(tx);
  if (currentAdminIds.has(targetUserId)) {
    const activeAdminCount = [...currentAdminIds].filter((id) =>
      id !== ROOT_USER_ID && activeAccounts.has(id)
    ).length;
    if (activeAdminCount <= 1) {
      throw new BadRequestError("不能注销最后一个可登录管理员");
    }
  }
  return anonymizeUserTx(
    tx,
    targetUserId,
    operationActor,
    undefined,
    options.meta,
    options,
  );
}

/** 用户自助注销：密码核验和账户事实在一个应用事务边界内完成。 */
export async function deleteOwnAccount(
  actor: UserActor,
  password: string,
  options: AccountLifecycleBoundary & { meta?: AccessWriteMeta },
): Promise<void> {
  const user = requireUserActor(actor);
  const passwordHash = await verifyOwnAccountPassword(user, password);
  const db: DbRoot = getDb();
  const result = await db.transaction((tx) =>
    deleteOwnAccountTx(tx, user, passwordHash, options)
  );
  await options.afterCommit({
    type: "account_deleted",
    userId: user.userId,
    previousAvatarUrl: result.avatarUrl,
  });
}

/** 管理员注销指定用户；管理员资格在本事务中按实时权限解析。 */
export async function adminDeleteAccount(
  actor: UserActor,
  targetUserId: string,
  options: AccountLifecycleBoundary & { meta?: AccessWriteMeta },
): Promise<void> {
  const operationActor = requireUserActor(actor);
  if (operationActor.userId === targetUserId) {
    throw new BadRequestError(
      "管理员不能从后台注销自己，请使用个人设置中的注销入口",
    );
  }
  const db: DbRoot = getDb();
  const result = await db.transaction((tx) =>
    adminDeleteAccountTx(tx, operationActor, targetUserId, options)
  );
  await options.afterCommit({
    type: "account_deleted",
    userId: targetUserId,
    previousAvatarUrl: result.avatarUrl,
  });
}

export { anonymizeUserTx };
