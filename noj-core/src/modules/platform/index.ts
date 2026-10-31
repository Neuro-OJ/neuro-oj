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
export {
  createSlide,
  deleteSlide,
  getCarouselImageBytes,
  listAllSlides,
  listEnabledSlides,
  MAX_CAROUSEL_IMAGE_SIZE,
  reorderSlides,
  updateSlide,
  uploadCarouselImage,
} from "./services/carousel.ts";
export type {
  CarouselKind,
  CarouselSlide,
  CarouselSlideInput,
} from "./services/carousel.ts";
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
export {
  getConsentedVersions,
  getLegalStatus,
  getUserConsent,
  recordConsent,
  recordConsentsForRegistration,
} from "./services/legal/consent.ts";
export {
  createDataRequest,
  DATA_REQUEST_KINDS,
  DATA_REQUEST_STATUSES,
  DATA_REQUEST_TARGETS,
  listAllDataRequests,
  listUserDataRequests,
  updateDataRequestStatus,
} from "./services/legal/data-requests.ts";
export type {
  DataRequestKind,
  DataRequestRow,
  DataRequestStatus,
  DataRequestTarget,
} from "./services/legal/data-requests.ts";
export {
  getCurrentDocument,
  getRequiredConsentInfo,
  getRequiredConsentVersion,
  hashContent,
  listVersions,
  normalizeContent,
  publishVersion,
} from "./services/legal/documents.ts";
export { isLegalKind, LEGAL_KINDS } from "./legal/types.ts";
export type {
  LegalConsentStatus,
  LegalDocumentSnapshot,
  LegalKind,
  LegalVersionSummary,
  UserConsentSnapshot,
} from "./legal/types.ts";
