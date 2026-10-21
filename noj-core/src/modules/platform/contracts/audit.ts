/**
 * 平台审计的原子写入合同。
 *
 * `audit_logs` 由 platform 拥有。业务模块（access、problems、evaluations 等）
 * 只能在**自己的业务事务**里调用本函数，把审计与业务事实一起提交或回滚；
 * 不允许业务模块直接 `insert(auditLogs)`，也不允许用根连接在提交后补写。
 *
 * 系统身份（bootstrap / migration / background_task）显式记录 purpose，
 * 不伪装成 root 用户。
 */
import type { DbTx } from "../../../shared/db/executor.ts";
import { auditLogs } from "../../../shared/db/schema.ts";
import type { Actor } from "../../access/contracts/actor.ts";
import type { AuditAction } from "../types/audit-log.ts";

/** 审计写入所需的请求元数据；缺 IP 时保留空串而不是伪造来源。 */
export interface AuditWriteMeta {
  readonly ipAddress?: string;
  readonly requestId?: string;
}

export interface AuditLogEntryInput {
  readonly actor: Actor;
  readonly action: AuditAction;
  readonly target?: { type: string; id: string };
  readonly detail?: Record<string, unknown>;
  readonly meta?: AuditWriteMeta;
  /** 记录时刻；缺省取当前时间。显式传入便于重放与测试。 */
  readonly createdAt?: string;
}

/**
 * 在调用方事务内追加一条平台审计。
 *
 * - `actor.kind === "user"` 时才写 `admin_id`；
 * - `actor.kind === "system"` 时把 purpose 写入 detail；
 * - `actor.kind === "guest"` 不会产生用户外键，也没有系统目的，视为调用错误。
 */
export async function appendAuditLogTx(
  tx: DbTx,
  input: AuditLogEntryInput,
): Promise<void> {
  const { actor } = input;
  if (actor.kind === "guest") {
    throw new TypeError(
      "审计写入需要已认证用户或显式系统身份，guest 不可写审计",
    );
  }
  const targetType = input.target?.type ?? null;
  const targetId = input.target?.id ?? null;
  await tx.insert(auditLogs).values({
    id: crypto.randomUUID(),
    admin_id: actor.kind === "user" ? actor.userId : null,
    action: input.action,
    target_type: targetType,
    target_id: targetId,
    ip_address: input.meta?.ipAddress ?? "",
    detail: {
      ...(input.detail ?? {}),
      ...(actor.kind === "system" ? { system_purpose: actor.purpose } : {}),
      ...(input.meta?.requestId ? { request_id: input.meta.requestId } : {}),
    },
    created_at: input.createdAt ?? new Date().toISOString(),
  });
}
