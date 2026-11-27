/**
 * 平台审计兼容入口（权威实现已迁入 `shared/audit/audit-log.ts`）。
 */
export {
  _resetAuditLogRetentionForTest,
  cleanupOldAuditLogs,
  listAuditLogs,
  logAuthEvent,
  recordAudit,
  recordAuthAudit,
  startAuditLogRetentionTask,
} from "../../../shared/audit/audit-log.ts";
export type { AuditMeta } from "../../../shared/audit/audit-log.ts";
