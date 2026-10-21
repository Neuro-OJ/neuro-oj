/**
 * @deprecated 系统设置已归 `modules/platform`。
 *
 * 这里保留旧域的字符串签名，供尚未迁移的路由、测试和跨域 fixture 使用；
 * 新业务必须从 platform 门面传入显式 `UserActor` 与请求元数据。
 */
import type { UserActor } from "../../../access/contracts/actor.ts";
import type { DbTx } from "../../../../shared/db/executor.ts";
import type { AuditMeta } from "../../services/audit-log.ts";
import {
  cleanupBootstrapRow as platformCleanupBootstrapRow,
  resetSetting as platformResetSetting,
  updateSetting as platformUpdateSetting,
} from "../../services/system-settings.ts";

function legacyActor(id: string): UserActor {
  const userId = id.trim();
  if (!userId) throw new TypeError("认证用户 ID 不能为空");
  return { kind: "user", userId: userId as UserActor["userId"] };
}

export type {
  RuntimeEnvConflict,
  SettingValue,
  SystemSettingListItem,
} from "../../services/system-settings.ts";
export {
  _resetSystemSettingsForTest,
  getSetting,
  hashSecret,
  initSystemSettings,
  listOrphanedBootstrapRows,
  listRuntimeEnvConflicts,
  listSettings,
  maskSecret,
  notifySettingsChanged,
  refreshSettingsCache,
  registerSettingsInvalidationListener,
  reloadSingleKey,
} from "../../services/system-settings.ts";

/** 旧域适配器：把已经认证的旧字符串签名转换成 UserActor。 */
export async function updateSetting(
  key: string,
  value: unknown,
  actorId: string,
  tx?: DbTx,
  auditMeta?: AuditMeta,
) {
  return await platformUpdateSetting(
    key,
    value,
    legacyActor(actorId),
    tx,
    auditMeta,
  );
}

/** 旧域适配器：把已经认证的旧字符串签名转换成 UserActor。 */
export async function resetSetting(
  key: string,
  actorId: string,
  auditMeta?: AuditMeta,
): Promise<void> {
  return await platformResetSetting(key, legacyActor(actorId), auditMeta);
}

/** 旧域适配器：把已经认证的旧字符串签名转换成 UserActor。 */
export async function cleanupBootstrapRow(
  key: string,
  actorId: string,
  auditMeta?: AuditMeta,
): Promise<void> {
  return await platformCleanupBootstrapRow(
    key,
    legacyActor(actorId),
    auditMeta,
  );
}
