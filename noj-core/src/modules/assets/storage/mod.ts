/**
 * 资产模块使用的存储能力。实现属于 transport；引用登记、容量保护和状态机
 * 由 `modules/assets/services` 负责。此文件只供 runtime/HTTP 组合与迁移期兼容层
 * 使用，业务模块应从 `modules/assets/index.ts` 取窄合同。
 */
export {
  getStorageProvider,
  getStorageProviderKind,
  resetStorageProvider,
  setStorageProviderForTest,
} from "./factory.ts";
export { LocalStorageProvider } from "./local.ts";
export { S3StorageProvider } from "./s3.ts";
export { deliverStoredArtifact } from "./artifact-delivery.ts";
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
} from "./types.ts";
export type {
  ParsedDownloadUrl,
  ParsedStorageUrl,
  StorageObjectInfo,
  StorageObjectStat,
  StorageProvider,
} from "./types.ts";
