/**
 * 旧 workspace 注册路径兼容适配器。
 *
 * 注册事实已由 modules/access/registration.ts 持有。该文件只保留旧测试和
 * 尚未迁移的教育调用方所需的参数形状；它不再自行创建默认 workspace 或
 * 把 root 当作用户身份。
 */
import type { Executor } from "../../../shared/db/executor.ts";
import { getDb } from "../../../shared/db/connection.ts";
import {
  assertInstanceRegistration,
  enrollRegisteredAccountTx,
} from "../../../modules/access/registration.ts";
import { userActorFromAuthenticatedId } from "../../../modules/access/contracts/actor.ts";

export { assertInstanceRegistration };

export async function enrollRegisteredAccount(
  executor: Executor,
  userId: string,
  invitationToken?: string,
): Promise<void> {
  const actor = userActorFromAuthenticatedId(userId);
  if ("transaction" in executor) {
    await getDb().transaction((tx) =>
      enrollRegisteredAccountTx(tx, actor, invitationToken)
    );
    return;
  }
  await enrollRegisteredAccountTx(executor, actor, invitationToken);
}
