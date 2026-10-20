/** access 本地审计事实写入；身份和 IP 都显式传入。 */
import type { DbTx } from "../../shared/db/executor.ts";
import { auditLogs } from "../../shared/db/schema.ts";
import type { SystemActor, UserActor } from "./contracts/actor.ts";
import type { WorkspaceAuditAction } from "../../shared/workspace/audit.ts";

export type AccessAuditActor = UserActor | SystemActor;

export interface AccessAuditMeta {
  readonly ipAddress?: string;
  readonly requestId?: string;
}

/**
 * 审计属于当前原子写入的一部分。SystemActor 没有用户外键，purpose 写入
 * detail，不能偷偷用 ROOT_USER_ID 伪装成用户。
 */
export async function workspaceAuditTx(
  tx: DbTx,
  actor: AccessAuditActor,
  domainId: string | null,
  action: WorkspaceAuditAction,
  detail: Record<string, unknown> = {},
  meta: AccessAuditMeta = {},
  target?: { type: string; id: string },
): Promise<void> {
  await tx.insert(auditLogs).values({
    id: crypto.randomUUID(),
    admin_id: actor.kind === "user" ? actor.userId : null,
    action,
    target_type: target?.type ?? "domain",
    target_id: target?.id ?? domainId,
    ip_address: meta.ipAddress ?? "",
    detail: {
      ...detail,
      domain_id: domainId,
      ...(actor.kind === "system" ? { system_purpose: actor.purpose } : {}),
      ...(meta.requestId ? { request_id: meta.requestId } : {}),
    },
    created_at: new Date().toISOString(),
  });
}
