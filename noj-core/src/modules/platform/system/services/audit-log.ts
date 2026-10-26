/**
 * @deprecated 审计事实已归 `modules/platform`。
 *
 * 旧 system 路径只保留两类迁移适配：旧 admin service 的 RequestContext
 * 调用形状，以及旧认证路径的字符串主体。新的 platform/application 写入必须
 * 直接调用 `recordAudit`/`recordAuthAudit` 并显式传入 actor 与 meta。
 */
import { recordAudit, recordAuthAudit } from "../../services/audit-log.ts";
import type { Actor, UserActor } from "../../../access/contracts/actor.ts";
import { getRequestContext } from "./request-context.ts";
import {
  _resetAuditLogRetentionForTest,
  cleanupOldAuditLogs,
  listAuditLogs,
  startAuditLogRetentionTask,
} from "../../services/audit-log.ts";
export type {
  AuditAction,
  AuditDetail,
  AuditLogEntry,
  AuditLogListFilter,
} from "../../types/audit-log.ts";
import type { AuditAction, AuditDetail } from "../../types/audit-log.ts";

function contextActor(): Actor | null {
  const context = getRequestContext();
  return context.actor ?? null;
}

/** 旧 admin service 适配：身份仍来自已注入的旧观测上下文。 */
export async function logAudit(
  action: AuditAction,
  detail: AuditDetail,
  target?: { type: string; id: string },
): Promise<void> {
  try {
    const context = getRequestContext();
    await recordAudit(
      contextActor(),
      {
        ipAddress: context.actorIp,
        requestId: context.requestId,
      },
      action,
      detail,
      target,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("RequestContext 未注入")
    ) return;
    throw error;
  }
}

/** 旧认证 service 适配：直接绑定已解析的主体 ID。 */
export async function logAuthEvent(
  actorUserId: string | null,
  clientIp: string,
  action: AuditAction,
  detail: Omit<AuditDetail, "action">,
): Promise<void> {
  const actor: UserActor | null = actorUserId
    ? {
      kind: "user",
      userId: actorUserId as UserActor["userId"],
    }
    : null;
  await recordAuthAudit(actor, clientIp, action, detail);
}

export {
  _resetAuditLogRetentionForTest,
  cleanupOldAuditLogs,
  listAuditLogs,
  startAuditLogRetentionTask,
};
