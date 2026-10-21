/**
 * access 本地审计事实写入。
 *
 * `audit_logs` 归 platform 所有；access 只构造审计条目并委托 platform 的
 * 原子合同写入，不直接 `insert(auditLogs)`。身份和请求元数据显式传入，
 * 不从 Hono Context/ALS 猜测。
 */
import type { DbTx } from "../../shared/db/executor.ts";
import type { SystemActor, UserActor } from "./contracts/actor.ts";
import type { WorkspaceAuditAction } from "../../shared/workspace/audit.ts";
import { appendAuditLogTx } from "../platform/contracts/audit.ts";
import { accessAuditEntry } from "./audit-entries.ts";

export type AccessAuditActor = UserActor | SystemActor;

export interface AccessAuditMeta {
  readonly ipAddress?: string;
  readonly requestId?: string;
}

/** 导出纯条目构造函数，供需要延迟写入的 application 用例复用。 */
export { accessAuditEntry };
export type { AccessAuditEntry } from "./audit-entries.ts";

/**
 * 审计属于当前原子写入的一部分，委托 platform 的 `appendAuditLogTx`。
 *
 * SystemActor 没有用户外键，purpose 写入 detail，不能偷偷用 ROOT_USER_ID
 * 伪装成用户。
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
  const entry = accessAuditEntry(
    actor,
    domainId,
    action,
    detail,
    meta,
    target,
  );
  await appendAuditLogTx(tx, {
    actor: entry.actor,
    action: entry.action,
    target: entry.target.id ? entry.target : undefined,
    detail: entry.detail,
    meta,
  });
}
