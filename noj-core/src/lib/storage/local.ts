/**
 * LocalStorageProvider — 本地文件系统存储实现
 *
 * ⚠️ 仅用于开发测试，不应在生产环境中使用。
 * 首次实例化时输出明确废弃警告。
 *
 * 存储路径：`data/packages/<base64-key>.zip`
 * URL 格式：`noj-storage://local/<base64>?checksum_sha256=<hex>`
 *
 * Judge 传输：仍使用 Base64 编码内联（judge 在独立容器中无法访问 core 文件系统）
 *   downloadUrl() 返回 `noj-download://base64/?content=[base64]&checksum_sha256=...`
 *
 * @module
 */

import {
  buildBase64DownloadUrl,
  buildStorageUrl,
  parseStorageUrl,
  sha256Hex,
  type StorageProvider,
} from "./types.ts";

const PACKAGES_DIR = "data/packages";

const DEPRECATED_WARNING = [
  `[storage/local] ⚠️  本地文件存储仅用于开发测试，不应在生产环境中使用。`,
  `[storage/local]    请设置 STORAGE_PROVIDER=s3 并配置 S3_ENDPOINT 以启用对象存储。`,
].join("\n");

/**
 * 本地文件系统存储实现
 *
 * 数据以 zip 文件形式存储在 `data/packages/` 目录下，
 * 文件名使用 SHA-256 的 base64url 编码（URL 安全）。
 */
export class LocalStorageProvider implements StorageProvider {
  private warned = false;

  constructor() {
    this.emitDeprecationWarning();
  }

  private emitDeprecationWarning(): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(DEPRECATED_WARNING);
  }

  /**
   * 存储数据到本地文件系统
   *
   * 1. 计算 SHA-256 哈希
   * 2. 将哈希编码为 base64url（URL 安全）
   * 3. 以哈希为文件名写入 `data/packages/`
   * 4. 返回 `noj-storage://local/<base64>?checksum_sha256=<hex>`
   */
  async put(
    _key: string,
    data: Uint8Array,
    _contentType?: string,
  ): Promise<string> {
    const hashHex = await sha256Hex(data);
    // 使用 base64url 编码哈希作为文件名（URL 安全）
    const base64Key = this.hexToBase64url(hashHex);
    const filePath = `${PACKAGES_DIR}/${base64Key}.zip`;

    // 原子写入：tmp 文件 + rename
    const tmpPath = `${filePath}.tmp.${crypto.randomUUID()}`;
    await Deno.mkdir(PACKAGES_DIR, { recursive: true });
    await Deno.writeFile(tmpPath, data);
    try {
      await Deno.rename(tmpPath, filePath);
    } catch {
      // Windows 跨设备 rename 可能失败，fallback 到 copy + remove
      await Deno.copyFile(tmpPath, filePath);
      await Deno.remove(tmpPath);
    }

    return buildStorageUrl("local", base64Key, hashHex);
  }

  /**
   * 根据 `noj-storage://` URL 读取数据
   */
  async get(url: string): Promise<Uint8Array> {
    const parsed = parseStorageUrl(url);
    const filePath = `${PACKAGES_DIR}/${parsed.key}.zip`;

    return await Deno.readFile(filePath);
  }

  /**
   * 根据 `noj-storage://` URL 删除数据
   *
   * 幂等操作：文件不存在时静默忽略
   */
  async delete(url: string): Promise<void> {
    const parsed = parseStorageUrl(url);
    const filePath = `${PACKAGES_DIR}/${parsed.key}.zip`;
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
    const data = await this.get(storageUrl);
    const parsed = parseStorageUrl(storageUrl);
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
