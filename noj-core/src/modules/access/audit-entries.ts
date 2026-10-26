/**
 * access 本地审计条目构造。
 *
 * access 不再直接写 `audit_logs`（platform 拥有的表）。这里只把 access 业务
 * 语义整理成**纯审计条目**；真正写入由 application 在同一个 `DbTx` 内调用
 * platform 的 `appendAuditLogTx` 完成，从而保证业务事实与审计共同提交。
 */
import type { SystemActor, UserActor } from "./contracts/actor.ts";
import type { WorkspaceAuditAction } from "../../shared/workspace/audit.ts";

export type AccessAuditActor = UserActor | SystemActor;

export interface AccessAuditMeta {
  readonly ipAddress?: string;
  readonly requestId?: string;
}

/** 纯审计条目：不依赖数据库句柄，可由调用方决定何时/在哪个事务写入。 */
export interface AccessAuditEntry {
  readonly actor: AccessAuditActor;
  readonly domainId: string | null;
  readonly action: WorkspaceAuditAction;
  readonly detail: Record<string, unknown>;
  readonly meta: AccessAuditMeta;
  readonly target: { type: string; id: string };
}

/**
 * 构造 access 审计条目。
 *
 * SystemActor 没有用户外键，purpose 写入 detail；不会用 ROOT_USER_ID 伪装用户。
 * 目标默认是域本身，可由调用方显式覆盖。
 */
export function accessAuditEntry(
  actor: AccessAuditActor,
  domainId: string | null,
  action: WorkspaceAuditAction,
  detail: Record<string, unknown> = {},
  meta: AccessAuditMeta = {},
  target?: { type: string; id: string },
): AccessAuditEntry {
  return {
    actor,
    domainId,
    action,
    detail: {
      ...detail,
      domain_id: domainId,
      ...(actor.kind === "system" ? { system_purpose: actor.purpose } : {}),
      ...(meta.requestId ? { request_id: meta.requestId } : {}),
    },
    meta,
    target: target ?? {
      type: "domain",
      ...(domainId ? { id: domainId } : { id: "" }),
    },
  };
}
