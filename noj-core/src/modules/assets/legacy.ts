/**
 * 资产迁移期兼容合同。
 *
 * 该文件只供尚未切换的旧 domain/runtime 适配器使用，不从
 * `modules/assets/index.ts` 公共业务门面导出。所有符号均显式列出，避免旧
 * 路径的通配导出把 provider、reconciliation 和测试能力重新泄漏给生产调用方。
 */
export {
  assertStorageObjectBindable,
  collectStorageReferences,
  compensateUploadedObject,
  deleteStorageObject,
  deleteStorageObjectTx,
  getStorageObject,
  registerLegacyStorageObject,
  registerReadyStorageObject,
  registerReadyStorageObjectTx,
  registerStorageObject,
  registerStreamedStorageObject,
  registerStreamedStorageObjectTx,
  releaseStorageObjectUploadReservation,
  reserveStorageObjectUpload,
  reserveStorageObjectUploadForContent,
  reserveStorageObjectUploadTx,
  STORAGE_UPLOAD_RESERVATION_TTL_MS,
  StorageObjectDeletedError,
  StorageObjectMissingError,
  StorageUploadInFlightError,
  uploadStorageObjectWithReservation,
  verifyStorageObject,
} from "./services/registry.ts";
export type {
  StorageDeleteOutcome,
  StorageObjectRecord,
  StorageReferenceReport,
  StorageUploadReservation,
} from "./services/registry.ts";
export {
  _resetDomainStorageReconciliationForTest,
  reconcileDomainStorageBatch,
  startDomainStorageReconciliation,
} from "./services/domain-reconciliation.ts";
export {
  buildStorageAuditReport,
  classifyStorageObjectKey,
  renderStorageAuditPrometheus,
} from "./services/audit.ts";
export type {
  StorageAuditObject,
  StorageAuditReport,
  StorageReference,
  StorageReferenceKind,
} from "./services/audit.ts";
export {
  attachDomainStorageUpload,
  attachDomainStorageUploadTx,
  getDomainOwnedStorageBytes,
  getDomainStorageUsage,
  growDomainStorageUpload,
  growDomainStorageUploadTx,
  listDomainStorageBaselineObjects,
  listDomainStorageReconciliationDomains,
  listExpiredDomainStorageUploads,
  reconcileDomainStorageCounters,
  releaseDomainStorageObject,
  releaseDomainStorageObjectTx,
  releaseDomainStorageUpload,
  releaseDomainStorageUploadTx,
  reserveDomainStorageUpload,
  reserveDomainStorageUploadTx,
  settleDomainStorageUpload,
  settleDomainStorageUploadTx,
} from "./services/storage-quota.ts";
