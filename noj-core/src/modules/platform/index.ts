/**
 * platform 业务窄门面。
 *
 * 只导出 HTTP/application 需要绑定的业务合同；测试重置、任务启动器、transport
 * 和旧 request-context 适配器保留在具体文件或 runtime descriptor 中。
 */
export {
  createAnnouncement,
  deleteAnnouncement,
  getLatestBannerAnnouncement,
  getPublicAnnouncement,
  listAdminAnnouncements,
  listPublicAnnouncements,
  resolveAnnouncementId,
  updateAnnouncement,
} from "./services/announcements.ts";
export type {
  AdminAnnouncementItem,
  AnnouncementBanner,
  AnnouncementDetail,
  AnnouncementSummary,
  CreateAnnouncementInput,
  PublicAnnouncementListResponse,
  UpdateAnnouncementInput,
} from "./services/announcements.ts";
export { contentScopeWhere, contentSource } from "./services/content-scope.ts";
export type { ContentScope } from "./services/content-scope.ts";
export {
  getInstanceAccessPolicy,
  getInstancePolicy,
  getInstanceResourcePolicy,
} from "./contracts/resource-policy.ts";
export {
  cleanupBootstrapRow,
  getSetting,
  initSystemSettings,
  listOrphanedBootstrapRows,
  listRuntimeEnvConflicts,
  listSettings,
  notifySettingsChanged,
  refreshSettingsCache,
  registerSettingsInvalidationListener,
  reloadSingleKey,
  resetSetting,
  updateSetting,
} from "./services/system-settings.ts";
export type {
  RuntimeEnvConflict,
  SettingValue,
  SystemSettingListItem,
} from "./services/system-settings.ts";
export {
  cleanupOldAuditLogs,
  listAuditLogs,
  recordAudit,
  recordAuthAudit,
  startAuditLogRetentionTask,
} from "./services/audit-log.ts";
export type { AuditMeta } from "./services/audit-log.ts";
export type {
  AuditAction,
  AuditDetail,
  AuditLogEntry,
  AuditLogListFilter,
} from "./types/audit-log.ts";
export {
  readInstanceSettings,
  saveInstanceSettings,
} from "./services/instance-settings.ts";
export {
  createJudgeImage,
  deleteJudgeImage,
  listJudgeImages,
  listJudgeImagesByKind,
  updateJudgeImage,
  validateJudgeImage,
  validateJudgeImageWithKind,
} from "./services/judge-images.ts";
export type {
  CreateJudgeImageInput,
  JudgeImageKind,
  JudgeImageResponse,
  UpdateJudgeImageInput,
} from "./types/judge-images.ts";

// 迁移期：供 src/features/* 使用签到写窗口限流（原经 cross-module 合同）。
export {
  enforceCheckinRateLimit,
  enforceRateLimit,
} from "./system/services/hardening-rate-limit.ts";
// 迁移期：供 src/features/* 使用（客户端 IP 遵循 TRUSTED_PROXIES，审计与限流须用它而非直接读请求头）。
export { getClientIp } from "./system/services/rate-limit-env.ts";
