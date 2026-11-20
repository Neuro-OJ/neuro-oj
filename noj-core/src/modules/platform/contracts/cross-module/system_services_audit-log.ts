/**
 * 跨模块窄能力合同；只列出生产调用方实际需要的符号。
 *
 * - `logAudit` / `logAuthEvent` 走旧适配层，会从 RequestContext 取主体与 IP；
 * - 新代码应显式传 actor 调用 `recordAudit`（不依赖隐式上下文）。
 */
export { logAudit, logAuthEvent } from "../../system/services/audit-log.ts";
export { recordAudit } from "../../services/audit-log.ts";
export type { AuditDetail } from "../../types/audit-log.ts";
