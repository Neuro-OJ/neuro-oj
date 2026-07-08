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
import { getSetting } from "../../services/system-settings.ts";

let instance: StorageProvider | null = null;

/**
 * 获取 StorageProvider 单例
 *
 * 读取 `STORAGE_PROVIDER` 环境变量，动态 import 对应模块。
 * 参考项目中已有的 email-provider 模式。
 */
export async function getStorageProvider(): Promise<StorageProvider> {
  if (instance) return instance;

  const provider = String(getSetting("storage_provider")?.value ?? "local");

  switch (provider) {
    case "s3": {
      const { S3StorageProvider } = await import("./s3.ts");
      const endpoint = String(getSetting("s3_endpoint")?.value ?? "");
      const region = String(getSetting("s3_region")?.value ?? "us-east-1");
      const accessKeyId = String(getSetting("s3_access_key")?.value ?? "");
      const secretAccessKey = String(getSetting("s3_secret_key")?.value ?? "");
      const bucket = String(
        getSetting("s3_bucket")?.value ?? "noj-support-packages",
      );
      const forcePathStyle = getSetting("s3_force_path_style")?.value === true;

      if (!endpoint) {
        throw new Error(
          "storage_provider=s3 但未配置 S3 端点（s3_endpoint），请通过系统设置或环境变量配置",
        );
      }
      if (!accessKeyId || !secretAccessKey) {
        throw new Error(
          "storage_provider=s3 但未配置访问密钥（s3_access_key / s3_secret_key），请通过系统设置或环境变量配置",
        );
      }

      instance = new S3StorageProvider({
        endpoint,
        region,
        accessKeyId,
        secretAccessKey,
        bucket,
        forcePathStyle,
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
