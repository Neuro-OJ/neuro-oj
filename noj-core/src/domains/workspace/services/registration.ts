/**
 * 旧 workspace 注册路径兼容适配器。
 *
 * 注册事实由 `modules/access/registration.ts` 持有。该文件只保留旧测试和
 * 尚未迁移的教育调用方所需的参数形状；它不再自行创建默认 workspace 或
 * 把 root 当作用户身份，也不再猜测“传入的是根连接还是事务”——调用方必须
 * 明确传入 `DbTx` 或 `DbRoot`。
 *
 * 迁移完成后本文件随旧 workspace 实现一起删除。
 */
import type { DbRoot, DbTx, Executor } from "../../../shared/db/executor.ts";
import { getDb } from "../../../shared/db/connection.ts";
import {
  assertInstanceRegistration,
  enrollRegisteredAccountTx,
  type InvitationRegistrationBoundary,
} from "../../../modules/access/registration.ts";
import { userActorFromAuthenticatedId } from "../../../modules/access/contracts/actor.ts";

export { assertInstanceRegistration };

/** 根连接上的旧入口：开启自己的事务，边界必须由调用方显式给出。 */
export function enrollRegisteredAccount(
  db: DbRoot,
  userId: string,
  invitationToken: string | undefined,
  options: { invitationBoundary?: InvitationRegistrationBoundary } = {},
): Promise<void> {
  const actor = userActorFromAuthenticatedId(userId);
  return db.transaction((tx) =>
    enrollRegisteredAccountTx(tx, actor, invitationToken, options)
  );
}

/** 事务内的旧入口：沿用调用方事务，不自行开启根事务。 */
export function enrollRegisteredAccountTxLegacy(
  tx: DbTx,
  userId: string,
  invitationToken: string | undefined,
  options: { invitationBoundary?: InvitationRegistrationBoundary } = {},
): Promise<void> {
  const actor = userActorFromAuthenticatedId(userId);
  return enrollRegisteredAccountTx(tx, actor, invitationToken, options);
}

/** 兼容旧的 `Executor` 参数形状；只接受真实事务，根连接必须显式构造。 */
export function enrollRegisteredAccountInExecutor(
  executor: Executor,
  userId: string,
  invitationToken?: string,
  options: { invitationBoundary?: InvitationRegistrationBoundary } = {},
): Promise<void> {
  if (executor === getDb()) {
    return enrollRegisteredAccount(getDb(), userId, invitationToken, options);
  }
  return enrollRegisteredAccountTxLegacy(
    executor as DbTx,
    userId,
    invitationToken,
    options,
  );
}
