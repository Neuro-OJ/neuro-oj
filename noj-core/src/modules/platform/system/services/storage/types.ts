/** @deprecated 存储 transport 已归 assets；仅保留测试/迁移入口。 */
export {
  buildBase64DownloadUrl,
  buildLocalDownloadUrl,
  buildS3DownloadUrl,
  buildStorageUrl,
  DOWNLOAD_URL_PREFIX,
  isDownloadUrl,
  isStorageUrl,
  parseDownloadUrl,
  parseStorageUrl,
  sha256Hex,
  STORAGE_URL_PREFIX,
  validateStorageKey,
} from "../../../../assets/storage/types.ts";
export type {
  ParsedDownloadUrl,
  ParsedStorageUrl,
  StorageObjectInfo,
  StorageObjectStat,
  StorageProvider,
} from "../../../../assets/storage/types.ts";
