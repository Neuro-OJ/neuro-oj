/**
 * @deprecated 对象存储业务能力已归 assets。该兼容入口将在 HTTP/runtime 组合层
 * 完成切换后删除；生产新代码不得依赖 system 门面。
 */
export {
  getStorageProvider,
  getStorageProviderKind,
  resetStorageProvider,
  setStorageProviderForTest,
} from "../../../../modules/assets/storage/factory.ts";
export { LocalStorageProvider } from "../../../../modules/assets/storage/local.ts";
export { S3StorageProvider } from "../../../../modules/assets/storage/s3.ts";
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
} from "../../../../modules/assets/legacy.ts";
export type {
  StorageDeleteOutcome,
  StorageObjectRecord,
  StorageReferenceReport,
  StorageUploadReservation,
} from "../../../../modules/assets/legacy.ts";
export { deliverStoredArtifact } from "../../../../modules/assets/storage/artifact-delivery.ts";
export {
  reconcileDomainStorageBatch,
  startDomainStorageReconciliation,
} from "../../../../modules/assets/legacy.ts";
export {
  buildStorageAuditReport,
  classifyStorageObjectKey,
  renderStorageAuditPrometheus,
} from "../../../../modules/assets/legacy.ts";
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
} from "../../../../modules/assets/storage/types.ts";
export type {
  ParsedDownloadUrl,
  ParsedStorageUrl,
  StorageObjectInfo,
  StorageObjectStat,
  StorageProvider,
} from "../../../../modules/assets/storage/types.ts";
export type {
  StorageAuditObject,
  StorageAuditReport,
  StorageReference,
  StorageReferenceKind,
} from "../../../../modules/assets/legacy.ts";
