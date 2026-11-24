import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";

export interface ZipEntry {
  /** 归档内相对路径（始终使用 `/` 分隔）。 */
  name: string;
  data: Buffer;
}

export interface CollectWorkspaceOptions {
  ignorePatterns?: readonly string[];
  maxTotalBytes?: number;
  maxFiles?: number;
}

const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_FILES = 2000;
const ALWAYS_IGNORED_SEGMENTS = new Set([".git", ".noj"]);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** 计算标准 IEEE 802.3 CRC-32 校验和。 */
export function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 规范化并校验 ZIP 条目路径，防止路径穿越。 */
export function normalizeArchivePath(entryPath: string): string {
  const normalized = entryPath
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
  if (!normalized) {
    throw new Error("ZIP 条目路径不能为空");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`ZIP 条目包含非法路径段：${entryPath}`);
  }
  return normalized;
}

/**
 * 零外部依赖构建标准 ZIP Buffer（支持 STORE 与 Raw DEFLATE）。
 * 使用 UTF-8 文件名标志位（0x0800），兼容系统 `unzip` 与 `fflate`。
 */
export function buildZipBuffer(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeArchivePath(entry.name);
    const nameBytes = Buffer.from(name, "utf8");
    const rawData = entry.data;
    const checksum = crc32(rawData);

    let method = 0;
    let payload: Buffer = rawData;
    if (rawData.length > 0) {
      const deflated = zlib.deflateRawSync(rawData);
      if (deflated.length < rawData.length) {
        method = 8;
        payload = deflated;
      }
    }

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x5421, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBytes, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x5421, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

/** 解析 `.nojignore` 文本为忽略规则数组。 */
export function parseIgnoreFile(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** 判断相对路径是否命中忽略规则。 */
export function isIgnoredPath(
  relativePath: string,
  patterns: readonly string[],
): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  if (segments.some((seg) => ALWAYS_IGNORED_SEGMENTS.has(seg))) return true;

  for (const raw of patterns) {
    const pattern = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!pattern) continue;
    const clean = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
    if (!clean) continue;

    if (clean.includes("*")) {
      const regex = new RegExp(
        `^${clean
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, "[^/]*")}$`,
      );
      if (regex.test(normalized) || segments.some((seg) => regex.test(seg))) {
        return true;
      }
      continue;
    }

    if (
      normalized === clean ||
      normalized.startsWith(`${clean}/`) ||
      segments.includes(clean)
    ) {
      return true;
    }
  }
  return false;
}

/** 递归收集工作区文件用于打包（自动应用 `.nojignore` 过滤并按路径排序）。 */
export async function collectWorkspaceFiles(
  rootDir: string,
  options: CollectWorkspaceOptions = {},
): Promise<ZipEntry[]> {
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  let patterns = options.ignorePatterns;
  if (!patterns) {
    try {
      const ignoreContent = await fs.readFile(
        path.join(rootDir, ".nojignore"),
        "utf8",
      );
      patterns = parseIgnoreFile(ignoreContent);
    } catch {
      patterns = [".venv", "__pycache__", ".git", "node_modules", ".noj"];
    }
  }

  const collected: ZipEntry[] = [];
  let totalBytes = 0;

  async function walk(currentDir: string, prefix: string): Promise<void> {
    const dirEntries = await fs.readdir(currentDir, { withFileTypes: true });
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of dirEntries) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (isIgnoredPath(rel, patterns!)) continue;
      const fullPath = path.join(currentDir, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        await walk(fullPath, rel);
      } else if (item.isFile()) {
        if (collected.length >= maxFiles) {
          throw new Error(`工作区打包文件数超过上限（${maxFiles} 个）`);
        }
        const data = await fs.readFile(fullPath);
        totalBytes += data.length;
        if (totalBytes > maxTotalBytes) {
          throw new Error(
            `工作区打包体积超过 ${(maxTotalBytes / 1024 / 1024).toFixed(0)} MiB 上限，请检查 .nojignore`,
          );
        }
        collected.push({ name: rel, data });
      }
    }
  }

  await walk(rootDir, "");
  return collected;
}

/** 一键打包工作区目录为标准 ZIP Buffer。 */
export async function packWorkspaceZip(
  rootDir: string,
  options: CollectWorkspaceOptions = {},
): Promise<{ buffer: Buffer; files: string[] }> {
  const entries = await collectWorkspaceFiles(rootDir, options);
  if (entries.length === 0) {
    throw new Error("工作区中没有可提交的文件（请检查 .nojignore 配置）");
  }
  return {
    buffer: buildZipBuffer(entries),
    files: entries.map((entry) => entry.name),
  };
}
