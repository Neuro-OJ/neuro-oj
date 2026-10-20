/**
 * @deprecated 法律文档服务已归 `modules/platform`。
 *
 * 旧路由和测试仍以 publisherId 调用；适配器只负责把已认证的旧字符串
 * 绑定为 UserActor，平台服务本身不再接受裸身份字符串。
 */
import type { UserActor } from "../../../modules/access/contracts/actor.ts";
import type { AuditMeta } from "../../../modules/platform/services/audit-log.ts";
import {
  getCurrentDocument,
  getRequiredConsentInfo,
  getRequiredConsentVersion,
  getVersionTsa,
  hashContent,
  listVersions,
  normalizeContent,
  publishVersion as platformPublishVersion,
} from "../../../modules/platform/services/legal/documents.ts";

function legacyActor(id: string): UserActor {
  const userId = id.trim();
  if (!userId) throw new TypeError("认证用户 ID 不能为空");
  return { kind: "user", userId: userId as UserActor["userId"] };
}

export {
  getCurrentDocument,
  getRequiredConsentInfo,
  getRequiredConsentVersion,
  getVersionTsa,
  hashContent,
  listVersions,
  normalizeContent,
};

/** 旧域适配器：把发布者 ID 绑定为显式 UserActor。 */
export async function publishVersion(
  kind: Parameters<typeof platformPublishVersion>[0],
  content: string,
  changeSummary: string | null,
  isMaterial: boolean,
  publisherId: string,
  auditMeta?: AuditMeta,
): Promise<number> {
  return await platformPublishVersion(
    kind,
    content,
    changeSummary,
    isMaterial,
    legacyActor(publisherId),
    auditMeta,
  );
}
