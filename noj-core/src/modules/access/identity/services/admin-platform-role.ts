/**
 * 平台角色写入用例（单值）。
 *
 * 路由层只接收 { role: "user" | "admin" }；打开外层事务后交给
 * admin-policy 的 setPlatformRoleTx 完成锁内校验与写入。
 */
import { getDb } from "../../../../shared/db/connection.ts";
import {
  type PlatformRoleChangeResult,
  setPlatformRoleTx,
} from "../../admin-policy.ts";

/** 设置目标用户的平台角色；返回 id/role 与真实旧角色供审计。 */
export async function setPlatformRole(
  actorId: string,
  targetUserId: string,
  role: unknown,
): Promise<PlatformRoleChangeResult> {
  const db = getDb();
  return await db.transaction((tx) =>
    setPlatformRoleTx(tx, { actorId, targetUserId, role })
  );
}
