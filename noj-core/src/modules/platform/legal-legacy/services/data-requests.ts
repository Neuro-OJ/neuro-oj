/**
 * @deprecated 法律请求服务已归 `modules/platform`。
 * 旧路由适配器负责把已认证字符串绑定为 UserActor。
 */
import type { UserActor } from "../../../access/contracts/actor.ts";
import type { AuditMeta } from "../../services/audit-log.ts";
import {
  createDataRequest as platformCreateDataRequest,
  DATA_REQUEST_KINDS,
  DATA_REQUEST_STATUSES,
  DATA_REQUEST_TARGETS,
  listAllDataRequests,
  listUserDataRequests,
  updateDataRequestStatus as platformUpdateDataRequestStatus,
} from "../../services/legal/data-requests.ts";

function legacyActor(id: string): UserActor {
  const userId = id.trim();
  if (!userId) throw new TypeError("认证用户 ID 不能为空");
  return { kind: "user", userId: userId as UserActor["userId"] };
}

export {
  DATA_REQUEST_KINDS,
  DATA_REQUEST_STATUSES,
  DATA_REQUEST_TARGETS,
  listAllDataRequests,
  listUserDataRequests,
};
export type {
  DataRequestKind,
  DataRequestRow,
  DataRequestStatus,
  DataRequestTarget,
} from "../../services/legal/data-requests.ts";

/** 旧域适配器：创建请求仍接受原有 userId 位置参数。 */
export async function createDataRequest(
  userId: string,
  kind: string,
  targetType: string,
  targetId: string | null,
  detail: string,
): Promise<string> {
  return await platformCreateDataRequest(
    legacyActor(userId),
    kind,
    targetType,
    targetId,
    detail,
  );
}

/** 旧域适配器：处置者 ID 绑定为显式 UserActor。 */
export async function updateDataRequestStatus(
  id: string,
  status: string,
  handledBy: string,
  resolution: string | null,
  auditMeta?: AuditMeta,
): Promise<void> {
  return await platformUpdateDataRequestStatus(
    id,
    status,
    legacyActor(handledBy),
    resolution,
    auditMeta,
  );
}
