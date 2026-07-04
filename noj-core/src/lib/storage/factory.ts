/**
 * StorageProvider 工厂函数
 *
 * 通过 `STORAGE_PROVIDER` 环境变量选择实现：
 * - `local`（默认）— LocalStorageProvider（仅开发测试）
 * - `s3` — S3StorageProvider（生产环境）
 *
 * 单例模式：模块级缓存，首次调用后复用同一实例。
 *
 * @module
 */

import type { StorageProvider } from "./types.ts";

let instance: StorageProvider | null = null;

/**
 * 获取 StorageProvider 单例
 *
 * 读取 `STORAGE_PROVIDER` 环境变量，动态 import 对应模块。
 * 参考项目中已有的 email-provider 模式。
 */
export async function getStorageProvider(): Promise<StorageProvider> {
  if (instance) return instance;

  const provider = Deno.env.get("STORAGE_PROVIDER") || "local";

  switch (provider) {
    case "s3": {
      const { S3StorageProvider } = await import("./s3.ts");
      const {
        S3_ENDPOINT,
        S3_REGION,
        S3_ACCESS_KEY,
        S3_SECRET_KEY,
        S3_BUCKET,
        S3_FORCE_PATH_STYLE,
      } = Deno.env.toObject();

      if (!S3_ENDPOINT) {
        throw new Error(
          "STORAGE_PROVIDER=s3 但未设置 S3_ENDPOINT 环境变量",
        );
      }
      if (!S3_ACCESS_KEY || !S3_SECRET_KEY) {
        throw new Error(
          "STORAGE_PROVIDER=s3 但未设置 S3_ACCESS_KEY 和 S3_SECRET_KEY",
        );
      }

      instance = new S3StorageProvider({
        endpoint: S3_ENDPOINT,
        region: S3_REGION || "us-east-1",
        accessKeyId: S3_ACCESS_KEY,
        secretAccessKey: S3_SECRET_KEY,
        bucket: S3_BUCKET || "noj-support-packages",
        forcePathStyle: S3_FORCE_PATH_STYLE === "true",
      });
      break;
    }
    case "local":
    default: {
      const { LocalStorageProvider } = await import("./local.ts");
      instance = new LocalStorageProvider();
      break;
    }
  }

  return instance;
}

/**
 * 重置单例（测试用）
 */
export function resetStorageProvider(): void {
  instance = null;
}
