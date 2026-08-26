/**
 * LocalStorageProvider — 本地文件系统存储实现
 *
 * ⚠️ 仅用于开发测试，不应在生产环境中使用。
 * 首次实例化时输出明确废弃警告。
 *
 * 存储路径：`data/storage/<base64-key>.zip`（默认目录，可用 `SUPPORT_PACKAGE_DIR` 覆盖）
 * URL 格式：`noj-storage://local/<base64>?checksum_sha256=<hex>`
 *
 * Judge 传输：仍使用 Base64 编码内联（judge 在独立容器中无法访问 core 文件系统）
 *   downloadUrl() 返回 `noj-download://base64/?content=[base64]&checksum_sha256=...`
 *
 * @module
 */

import { relative, resolve } from "jsr:@std/path@^1";
import { sha256 } from "npm:@noble/hashes@2.2.0/sha2.js";
import {
  buildBase64DownloadUrl,
  buildStorageUrl,
  parseStorageUrl,
  sha256Hex,
  type StorageProvider,
  validateStorageKey,
} from "./types.ts";
import { logger } from "../logging.ts";

/**
 * 本地存储根目录（实例级，构造时解析，测试可用 SUPPORT_PACKAGE_DIR 覆盖）。
 *
 * 与构建产物目录（`data/packages/`）分离，避免混淆（problem-bundle-import）。
 * 默认 `data/storage/`，可用 `SUPPORT_PACKAGE_DIR` 环境变量覆盖（历史配置名保留）。
 */

const DEPRECATED_WARNING = [
  `[storage/local] ⚠️  本地文件存储仅用于开发测试，不应在生产环境中使用。`,
  `[storage/local]    请设置 STORAGE_PROVIDER=s3 并配置 S3_ENDPOINT 以启用对象存储。`,
].join("\n");

/** contentType → 扩展名映射（仅图片需要；zip 保持无扩展名兼容既有 URL） */
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** 已知扩展名（get/delete 解析 key 时使用） */
const KNOWN_EXTS = /\.(png|jpe?g|webp)$/i;

/** 根据 contentType 推导文件扩展名；未知（含 zip）返回空串（无扩展名） */
function extensionFor(contentType?: string): string {
  return (contentType && EXT_BY_CONTENT_TYPE[contentType]) ?? "";
}

/**
 * key → 磁盘文件路径（含根目录约束）。
 *
 * NOJ-061/NOJ-115：拒绝任何 `/`（local key 由服务端内容寻址生成，
 * 天然无路径分隔），resolve 后再次断言仍在 storageDir 内。
 */
function filePathFor(storageDir: string, key: string): string {
  validateStorageKey(key);
  if (key.includes("/")) {
    throw new Error(`local 存储 key 不得包含路径分隔符: ${key}`);
  }
  const suffix = KNOWN_EXTS.test(key) ? "" : ".zip";
  const root = resolve(storageDir);
  const filePath = resolve(root, `${key}${suffix}`);
  const rel = relative(root, filePath);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`local 存储 key 越界: ${key}`);
  }
  return filePath;
}

/**
 * 本地文件系统存储实现
 *
 * 数据以 zip 文件形式存储在 `${this.storageDir}/` 目录下，
 * 文件名使用 SHA-256 的 base64url 编码（URL 安全）。
 * 图片（头像等）按 contentType 附带扩展名：`<hash>.png` / `<hash>.jpg` / `<hash>.webp`。
 */
export class LocalStorageProvider implements StorageProvider {
  private warned = false;

  /** 存储根目录（构造时解析 SUPPORT_PACKAGE_DIR，缺省 data/storage）。 */
  private readonly storageDir: string = Deno.env.get("SUPPORT_PACKAGE_DIR") ??
    "data/storage";

  constructor() {
    this.emitDeprecationWarning();
  }

  private emitDeprecationWarning(): void {
    if (this.warned) return;
    this.warned = true;
    logger.warn(DEPRECATED_WARNING);
  }

  /**
   * 存储数据到本地文件系统
   *
   * 1. 计算 SHA-256 哈希
   * 2. 将哈希编码为 base64url（URL 安全）
   * 3. 以哈希为文件名写入存储根目录（`_key` 忽略——文件名由内容寻址决定）
   * 4. 返回 `noj-storage://local/<base64>[.<ext>]?checksum_sha256=<hex>`
   *
   * 扩展名规则：`image/png→png`、`image/jpeg→jpg`、`image/webp→webp`；
   * 其余 contentType（含 zip）保持无扩展名，兼容既有支持包 URL。
   */
  async put(
    _key: string,
    data: Uint8Array,
    contentType?: string,
  ): Promise<string> {
    const hashHex = await sha256Hex(data);
    // 使用 base64url 编码哈希作为文件名（URL 安全）
    const base64Key = this.hexToBase64url(hashHex);
    const ext = extensionFor(contentType);
    // 磁盘文件：图片带扩展名（png/jpg/webp），zip 固定 .zip；
    // URL key：图片带扩展名，zip 保持无扩展名（兼容既有 URL）
    const fileName = ext ? `${base64Key}.${ext}` : `${base64Key}.zip`;
    const filePath = `${this.storageDir}/${fileName}`;

    // 原子写入：tmp 文件 + rename
    const tmpPath = `${filePath}.tmp.${crypto.randomUUID()}`;
    await Deno.mkdir(this.storageDir, { recursive: true });
    await Deno.writeFile(tmpPath, data);
    try {
      await Deno.rename(tmpPath, filePath);
    } catch {
      // Windows 跨设备 rename 可能失败，fallback 到 copy + remove
      await Deno.copyFile(tmpPath, filePath);
      await Deno.remove(tmpPath);
    }

    return buildStorageUrl("local", ext ? fileName : base64Key, hashHex);
  }

  /**
   * 流式存储数据到本地文件系统。
   *
   * 与 put() 相同的内容寻址语义：先写临时文件，边写边计算 SHA-256，
   * 完成后以哈希为文件名原子 rename 到存储目录。
   */
  async putStream(
    _key: string,
    stream: ReadableStream<Uint8Array>,
    contentType?: string,
    maxSizeBytes?: number,
  ): Promise<string> {
    const hash = sha256.create();
    const ext = extensionFor(contentType);
    const tmpPath = `${this.storageDir}/.tmp-${crypto.randomUUID()}`;
    await Deno.mkdir(this.storageDir, { recursive: true });
    const file = await Deno.open(tmpPath, {
      write: true,
      create: true,
      truncate: true,
    });
    let total = 0;
    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          total += value.length;
          if (maxSizeBytes !== undefined && total > maxSizeBytes) {
            throw new Error(
              `文件超过大小限制（${maxSizeBytes} 字节）`,
            );
          }
          hash.update(value);
          await file.write(value);
        }
      }
    } catch (err) {
      try {
        file.close();
      } catch {
        // ignore close failure
      }
      await Deno.remove(tmpPath).catch(() => {});
      throw err;
    }
    file.close();

    const hashHex = Array.from(hash.digest())
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const base64Key = this.hexToBase64url(hashHex);
    const fileName = ext ? `${base64Key}.${ext}` : `${base64Key}.zip`;
    const filePath = `${this.storageDir}/${fileName}`;

    try {
      await Deno.rename(tmpPath, filePath);
    } catch {
      // Windows 跨设备 rename 可能失败，fallback 到 copy + remove
      await Deno.copyFile(tmpPath, filePath);
      await Deno.remove(tmpPath);
    }

    return buildStorageUrl("local", ext ? fileName : base64Key, hashHex);
  }

  /**
   * 根据 `noj-storage://` URL 读取数据
   */
  get(url: string): Promise<Uint8Array> {
    const parsed = parseStorageUrl(url);
    if (parsed.provider !== "local") {
      throw new Error(`local provider 拒绝 ${parsed.provider} URL`);
    }
    const filePath = filePathFor(this.storageDir, parsed.key);

    return Deno.readFile(filePath);
  }

  /**
   * 根据 `noj-storage://` URL 删除数据
   *
   * 幂等操作：文件不存在时静默忽略
   */
  async delete(url: string): Promise<void> {
    const parsed = parseStorageUrl(url);
    if (parsed.provider !== "local") {
      throw new Error(`local provider 拒绝 ${parsed.provider} URL`);
    }
    const filePath = filePathFor(this.storageDir, parsed.key);
    try {
      await Deno.remove(filePath);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        // 幂等删除
        return;
      }
      throw err;
    }
  }

  /**
   * 将 `noj-storage://` URL 转换为 `noj-download://base64/` URL
   *
   * 读取文件 → Base64 编码 → 构建 download URL
   */
  async downloadUrl(storageUrl: string, _expiresIn?: number): Promise<string> {
    const parsed = parseStorageUrl(storageUrl);
    if (parsed.provider !== "local") {
      throw new Error(`local provider 拒绝 ${parsed.provider} URL`);
    }
    const data = await this.get(storageUrl);
    const base64Content = this.uint8ArrayToBase64(data);
    return buildBase64DownloadUrl(base64Content, parsed.checksumSha256);
  }

  // ── 内部工具 ─────────────────────────────────────────────

  /**
   * 将十六进制字符串编码为 base64url（无填充）
   */
  private hexToBase64url(hex: string): string {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    // base64url 编码（无填充）
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  /**
   * 将 Uint8Array 编码为标准 Base64
   */
  private uint8ArrayToBase64(data: Uint8Array): string {
    return btoa(String.fromCharCode(...data));
  }
}
