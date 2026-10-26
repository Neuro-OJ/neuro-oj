/** @deprecated 实例设置已归 `modules/platform`；保留旧路由的字符串适配。 */
import type { UserActor } from "../../../access/contracts/actor.ts";
import type { AuditMeta } from "../../services/audit-log.ts";
import {
  readInstanceSettings,
  saveInstanceSettings as platformSaveInstanceSettings,
} from "../../services/instance-settings.ts";

function legacyActor(id: string): UserActor {
  const userId = id.trim();
  if (!userId) throw new TypeError("认证用户 ID 不能为空");
  return { kind: "user", userId: userId as UserActor["userId"] };
}

export { readInstanceSettings };

/** 旧域适配器：HTTP 迁移完成前把认证用户 ID 绑定为 UserActor。 */
export async function saveInstanceSettings(
  section: string,
  values: Record<string, unknown>,
  revision: string | undefined,
  actorId: string,
  auditMeta?: AuditMeta,
) {
  return await platformSaveInstanceSettings(
    section,
    values,
    revision,
    legacyActor(actorId),
    auditMeta,
  );
}
