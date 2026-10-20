/** assets 业务模块公共窄门面。
 *
 * 这里仅导出对象引用、上传预约、容量保护和交付合同。transport 工厂、测试注入
 * 与后台 reconciliation 不从业务门面泄漏；runtime 组合层直接使用其私有 descriptor。
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
  attachDomainStorageUpload,
  attachDomainStorageUploadTx,
  getDomainOwnedStorageBytes,
  getDomainStorageUsage,
  growDomainStorageUpload,
  growDomainStorageUploadTx,
  releaseDomainStorageObject,
  releaseDomainStorageObjectTx,
  releaseDomainStorageUpload,
  releaseDomainStorageUploadTx,
  reserveDomainStorageUpload,
  reserveDomainStorageUploadTx,
  settleDomainStorageUpload,
  settleDomainStorageUploadTx,
} from "./services/storage-quota.ts";
export { deliverStoredArtifact } from "./storage/artifact-delivery.ts";
export type {
  ParsedDownloadUrl,
  ParsedStorageUrl,
  StorageObjectInfo,
  StorageObjectStat,
  StorageProvider,
} from "./storage/types.ts";
export {
  isDownloadUrl,
  isStorageUrl,
  parseDownloadUrl,
  parseStorageUrl,
} from "./storage/types.ts";
