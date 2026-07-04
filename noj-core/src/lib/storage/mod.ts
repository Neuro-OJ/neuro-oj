/**
 * 抽象存储层 — 公共导出
 *
 * 提供 StorageProvider 接口、URL 工具、LocalStorageProvider 和 S3StorageProvider 实现。
 *
 * 使用方式：
 * ```ts
 * import { getStorageProvider } from "#src/lib/storage/mod.ts";
 * const storage = await getStorageProvider();
 * const url = await storage.put("key", data);
 * ```
 *
 * @module
 */

export { getStorageProvider, resetStorageProvider } from "./factory.ts";
export { LocalStorageProvider } from "./local.ts";
export { S3StorageProvider } from "./s3.ts";
export {
  buildBase64DownloadUrl,
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
  StorageProvider,
} from "./types.ts";
