/**
 * @deprecated 对象存储业务能力已归 assets。该兼容入口将在 HTTP/runtime 组合层
 * 完成切换后删除；生产新代码不得依赖 system 门面。
 */
export {
  getStorageProvider,
  getStorageProviderKind,
  resetStorageProvider,
  setStorageProviderForTest,
} from "../../../../assets/storage/factory.ts";
export { LocalStorageProvider } from "../../../../assets/storage/local.ts";
export { S3StorageProvider } from "../../../../assets/storage/s3.ts";
export {
  assertStorageObjectBindable,
  collectStorageReferences,
  compensateUploadedObject,
  deleteStorageObject,
  getStorageObject,
  registerLegacyStorageObject,
  registerReadyStorageObject,
  registerStorageObject,
  registerStreamedStorageObject,
  releaseStorageObjectUploadReservation,
  reserveStorageObjectUpload,
  reserveStorageObjectUploadForContent,
  STORAGE_UPLOAD_RESERVATION_TTL_MS,
  StorageObjectDeletedError,
  StorageObjectMissingError,
  StorageUploadInFlightError,
  uploadStorageObjectWithReservation,
  verifyStorageObject,
} from "../../../../assets/legacy.ts";
export type {
  StorageDeleteOutcome,
  StorageObjectRecord,
  StorageReferenceReport,
  StorageUploadReservation,
} from "../../../../assets/legacy.ts";
export { deliverStoredArtifact } from "../../../../assets/storage/artifact-delivery.ts";
export {
  reconcileDomainStorageBatch,
  startDomainStorageReconciliation,
} from "../../../../assets/legacy.ts";
export {
  buildStorageAuditReport,
  classifyStorageObjectKey,
  renderStorageAuditPrometheus,
} from "../../../../assets/legacy.ts";
export {
  buildBase64DownloadUrl,
  buildLocalDownloadUrl,
  buildS3DownloadUrl,
  buildStorageUrl,
  isDownloadUrl,
  isStorageUrl,
  parseDownloadUrl,
  parseStorageUrl,
  sha256Hex,
} from "../../../../assets/storage/types.ts";
export type {
  ParsedDownloadUrl,
  ParsedStorageUrl,
  StorageObjectInfo,
  StorageObjectStat,
  StorageProvider,
} from "../../../../assets/storage/types.ts";
export type {
  StorageAuditObject,
  StorageAuditReport,
  StorageReference,
  StorageReferenceKind,
} from "../../../../assets/legacy.ts";
