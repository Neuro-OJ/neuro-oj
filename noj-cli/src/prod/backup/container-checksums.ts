/** `.nojbackup` 容器的 sha256sums 生成与解析（从 container.ts 拆出）。
 */

import { fileSha256HexStreaming } from "./sha256.ts";

/**
 * 有界内存地计算文件 SHA-256（委托 `./sha256.ts` 的纯 TS 增量实现）。
 *
 * **不用** `util/hash.ts:fileSha256Hex`——那个 `Deno.readFile` 整读，对数百 MB
 * 的 `postgres.dump` 会吃满内存。方案取舍见 `./sha256.ts` 的模块 JSDoc。
 */
export { fileSha256HexStreaming };

/** staging 内一个文件的相对路径与摘要。 */
export interface ChecksumEntry {
  relPath: string;
  sha256: string;
}

/**
 * 生成 `sha256sums.txt` 正文（`backup.sh:187-195` 的等价）。
 *
 * 逐字对齐三点：
 * - 每行 `<摘要>  <相对路径>`（**两个空格**，sha256sum 的 GNU 格式）；
 * - `sha256sums.txt` **自身不入选**；
 * - 顺序按 `LC_ALL=C sort`（即 UTF-8 字节序；JS 的默认字符串比较对 BMP
 *   内的 ASCII 与 UTF-8 字节序一致，故直接用 `sort()` 即可，但为避免非 ASCII
 *   路径的差异，这里显式按码点比较并注明）。
 */
export function renderChecksums(entries: readonly ChecksumEntry[]): string {
  const sorted = [...entries].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
  );
  return sorted.map((e) => `${e.sha256}  ${e.relPath}`).join("\n") +
    (sorted.length > 0 ? "\n" : "");
}

/**
 * 解析 `sha256sums.txt`（verify 用）。
 *
 * 宽容解析：跳过空行；每行按**首个两空格**切分（路径自身可能含空格，
 * 故不能用 `split(" ")`）。格式非法即抛错——静默跳过会让校验形同虚设。
 */
export function parseChecksums(text: string): ChecksumEntry[] {
  const out: ChecksumEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const sep = line.indexOf("  ");
    if (sep <= 0) throw new Error(`sha256sums.txt 行格式非法：${line}`);
    const sha256 = line.slice(0, sep);
    const relPath = line.slice(sep + 2);
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`sha256sums.txt 摘要非法：${line}`);
    }
    out.push({ relPath, sha256 });
  }
  return out;
}
