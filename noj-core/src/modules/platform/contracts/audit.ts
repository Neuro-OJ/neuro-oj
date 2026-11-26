/**
 * 平台审计原子写入兼容入口（权威实现已迁入 `shared/audit/audit-log.ts`）。
 */
export { appendAuditLogTx } from "../../../shared/audit/audit-log.ts";
export type {
  AuditLogEntryInput,
  AuditWriteMeta,
} from "../../../shared/audit/audit-log.ts";
