/**
 * @deprecated 法律同意服务已归 `modules/platform`。
 * 旧域适配器保留 userId 参数布局，平台合同要求显式 UserActor。
 */
import type { UserActor } from "../../../access/contracts/actor.ts";
import type { DbTx } from "../../../../shared/db/executor.ts";
import {
  getConsentedVersions,
  getLegalStatus,
  getUserConsent,
  recordConsent as platformRecordConsent,
  recordConsentsForRegistration as platformRecordConsentsForRegistration,
} from "../../services/legal/consent.ts";

function legacyActor(id: string): UserActor {
  const userId = id.trim();
  if (!userId) throw new TypeError("认证用户 ID 不能为空");
  return { kind: "user", userId: userId as UserActor["userId"] };
}

export { getConsentedVersions, getLegalStatus, getUserConsent };

/** 旧域适配器：记录同意仍接受原有 userId 参数。 */
export async function recordConsent(
  userId: string,
  kind: Parameters<typeof platformRecordConsent>[1],
  version: number,
  hash: string,
  ip: string | null,
  ua: string | null,
): Promise<void> {
  return await platformRecordConsent(
    legacyActor(userId),
    kind,
    version,
    hash,
    ip,
    ua,
  );
}

/** 旧域适配器：注册事务仍接受原有 userId 参数。 */
export async function recordConsentsForRegistration(
  tx: DbTx,
  userId: string,
  ip: string | null,
  ua: string | null,
): Promise<void> {
  return await platformRecordConsentsForRegistration(
    tx,
    legacyActor(userId),
    ip,
    ua,
  );
}
