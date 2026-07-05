/**
 * StorageProvider 抽象接口与 URL 工具
 *
 * 定义两种 URL 空间：
 * - `noj-storage://` — DB 持久存储层，标识资源在存储后端的位置
 * - `noj-download://` — Judge 交付层，描述 judge 如何获取支持包内容
 *
 * @module
 */

// ── URL 类型定义 ─────────────────────────────────────────────

/** `noj-storage://` URL 的解析结果 */
export interface ParsedStorageUrl {
  /** 存储后端标识：`local` 或 `s3` */
  provider: "local" | "s3";
  /** 存储后端内的资源路径（local 模式下为 base64 编码；S3 模式下为对象键） */
  key: string;
  /** SHA-256 校验和（十六进制），可能为空 */
  checksumSha256?: string;
}

/** `noj-download://` URL 的解析结果 */
export interface ParsedDownloadUrl {
  /** 下载方式：`base64`（内嵌数据）或 `s3`（presigned URL） */
  mode: "base64" | "s3";
  /** base64 模式下的原始内容（base64 编码） */
  content?: string;
  /** S3 模式下的 presigned URL（已百分号解码） */
  url?: string;
  /** SHA-256 校验和（十六进制），可能为空 */
  checksumSha256?: string;
}

// ── URL 常量 ─────────────────────────────────────────────────

export const STORAGE_URL_PREFIX = "noj-storage://";
export const DOWNLOAD_URL_PREFIX = "noj-download://";

// ── StorageProvider 接口 ─────────────────────────────────────

/**
 * 抽象存储层接口
 *
 * 参考项目中已有的 email-provider 模式，通过环境变量选择实现。
 * 支持本地文件系统和 S3 兼容对象存储两种后端。
 */
export interface StorageProvider {
  /**
   * 存储数据并返回 `noj-storage://` URL
   *
   * @param key 存储键（local 模式下为 base64 编码路径；S3 模式下为对象键）
   * @param data 原始字节数据
   * @param contentType 内容类型（S3 模式下使用）
   * @returns `noj-storage://` URL，包含 checksum_sha256
   */
  put(key: string, data: Uint8Array, contentType?: string): Promise<string>;

  /**
   * 根据 `noj-storage://` URL 读取数据
   *
   * @param url `noj-storage://` URL 或 legacy 本地路径
   * @returns 原始字节数据
   */
  get(url: string): Promise<Uint8Array>;

  /**
   * 根据 `noj-storage://` URL 删除数据
   *
   * @param url `noj-storage://` URL
   */
  delete(url: string): Promise<void>;

  /**
   * 将 `noj-storage://` URL 转换为 `noj-download://` URL（Judge 交付层）
   *
   * @param storageUrl `noj-storage://` URL
   * @param expiresIn 有效期（秒），仅 S3 模式有效
   * @returns `noj-download://` URL
   */
  downloadUrl(storageUrl: string, expiresIn?: number): Promise<string>;

  /**
   * 确保存储后端就绪（如 S3 bucket 存在）
   * 非致命——失败仅 warn，不阻止启动
   */
  ensureBucket?(): Promise<void>;
}

// ── `noj-storage://` URL 工具 ────────────────────────────────

/**
 * 判断字符串是否为 `noj-storage://` URL
 */
export function isStorageUrl(value: string): boolean {
  return value.startsWith(STORAGE_URL_PREFIX);
}

/**
 * 解析 `noj-storage://` URL
 *
 * 格式：
 *   noj-storage://local/<base64>?checksum_sha256=<hex>
 *   noj-storage://s3/<key>?checksum_sha256=<hex>
 *
 * @throws {Error} 非 `noj-storage://` 前缀的 URL 直接拒绝
 */
export function parseStorageUrl(url: string): ParsedStorageUrl {
  if (!isStorageUrl(url)) {
    throw new Error(`不是合法的 noj-storage:// URL: ${url}`);
  }

  const withoutPrefix = url.slice(STORAGE_URL_PREFIX.length);
  const queryStart = withoutPrefix.indexOf("?");

  let path: string;
  let checksumSha256: string | undefined;

  if (queryStart === -1) {
    path = withoutPrefix;
  } else {
    path = withoutPrefix.slice(0, queryStart);
    const query = withoutPrefix.slice(queryStart + 1);
    const params = new URLSearchParams(query);
    checksumSha256 = params.get("checksum_sha256") ?? undefined;
  }

  const slashIndex = path.indexOf("/");
  if (slashIndex === -1) {
    // 只有 provider 无 key
    return { provider: path as "local" | "s3", key: "", checksumSha256 };
  }

  const provider = path.slice(0, slashIndex) as "local" | "s3";
  const key = path.slice(slashIndex + 1);

  return { provider, key, checksumSha256 };
}

/**
 * 构建 `noj-storage://` URL
 */
export function buildStorageUrl(
  provider: "local" | "s3",
  key: string,
  checksumSha256?: string,
): string {
  let url = `${STORAGE_URL_PREFIX}${provider}/${key}`;
  if (checksumSha256) {
    url += `?checksum_sha256=${checksumSha256}`;
  }
  return url;
}

// ── `noj-download://` URL 工具 ───────────────────────────────

/**
 * 判断字符串是否为 `noj-download://` URL
 */
export function isDownloadUrl(value: string): boolean {
  return value.startsWith(DOWNLOAD_URL_PREFIX);
}

/**
 * 解析 `noj-download://` URL
 *
 * 格式：
 *   noj-download://base64/?content=[base64]&checksum_sha256=<hex>
 *   noj-download://s3?url=[percent-encoded-presigned-URL]&checksum_sha256=<hex>
 */
export function parseDownloadUrl(url: string): ParsedDownloadUrl {
  const withoutPrefix = url.slice(DOWNLOAD_URL_PREFIX.length);

  // Extract host (before first / or ?)
  const queryStart = withoutPrefix.indexOf("?");
  const hostEnd = queryStart === -1 ? withoutPrefix.length : queryStart;
  const slashIndex = withoutPrefix.indexOf("/");
  const host = (slashIndex !== -1 && slashIndex < hostEnd)
    ? withoutPrefix.slice(0, slashIndex)
    : withoutPrefix.slice(0, hostEnd);

  const query = queryStart === -1 ? "" : withoutPrefix.slice(queryStart + 1);
  const params = new URLSearchParams(query);

  const checksumSha256 = params.get("checksum_sha256") ?? undefined;

  if (host === "base64") {
    return {
      mode: "base64",
      content: params.get("content") ?? undefined,
      checksumSha256,
    };
  }

  if (host === "s3") {
    const rawUrl = params.get("url");
    return {
      mode: "s3",
      url: rawUrl ? decodeURIComponent(rawUrl) : undefined,
      checksumSha256,
    };
  }

  throw new Error(`Unknown noj-download:// host: ${host}`);
}

/**
 * 构建 `noj-download://base64/` URL
 */
export function buildBase64DownloadUrl(
  content: string,
  checksumSha256?: string,
): string {
  let url = `${DOWNLOAD_URL_PREFIX}base64/?content=${content}`;
  if (checksumSha256) {
    url += `&checksum_sha256=${checksumSha256}`;
  }
  return url;
}

/**
 * 构建 `noj-download://s3` URL
 *
 * @param presignedUrl S3 presigned URL（会被百分号编码嵌入）
 * @param checksumSha256 SHA-256 校验和
 */
export function buildS3DownloadUrl(
  presignedUrl: string,
  checksumSha256?: string,
): string {
  const encoded = encodeURIComponent(presignedUrl);
  let url = `${DOWNLOAD_URL_PREFIX}s3?url=${encoded}`;
  if (checksumSha256) {
    url += `&checksum_sha256=${checksumSha256}`;
  }
  return url;
}

// ── 哈希工具 ─────────────────────────────────────────────────

/**
 * 计算 Uint8Array 的 SHA-256 哈希（十六进制）
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    data as unknown as BufferSource,
  );
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
