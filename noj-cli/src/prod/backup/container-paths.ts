/** `.nojbackup` 容器路径、时间戳与文件枚举辅助（从 container.ts 拆出）。
 */

import { dirname, join } from "@std/path";
import { BACKUP_SUFFIX } from "./container.ts";

/**
 * 备份产物的文件名（`snapshot-<ts>` + {@link BACKUP_SUFFIX}）。
 *
 * 时间戳格式 `%Y%m%d-%H%M%S`（bash `backup.sh:238` 的 `date '+%Y%m%d-%H%M%S'`），
 * 可在 `prod/backup/index.ts:parseBackupName` 的既有解析下工作，从而让
 * `list`/`prune` 无需感知容器细节。
 */
export function containerFileName(ts: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const stamp =
    `${ts.getUTCFullYear()}${p(ts.getUTCMonth() + 1)}${p(ts.getUTCDate())}` +
    `-${p(ts.getUTCHours())}${p(ts.getUTCMinutes())}${p(ts.getUTCSeconds())}`;
  return `snapshot-${stamp}${BACKUP_SUFFIX}`;
}

/**
 * 在 `backupDir` 中挑一个**未被占用**的容器路径（bash `:239-243` 的等价）。
 *
 * bash 用 `-e` 判存在并在冲突时追加 `-<index>`；本实现同样追加序号，
 * 保证既不覆盖既有快照，也不因并发创建而互相踩踏。
 */
export async function allocateContainerPath(
  backupDir: string,
  ts: Date,
): Promise<string> {
  const base = containerFileName(ts).slice(0, -BACKUP_SUFFIX.length);
  let candidate = join(backupDir, base + BACKUP_SUFFIX);
  let index = 1;
  while (await pathExists(candidate)) {
    candidate = join(backupDir, `${base}-${index}${BACKUP_SUFFIX}`);
    index++;
  }
  return candidate;
}

/** `-e` 语义的存在性判定（含悬空软链）。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** 格式化为 bash `date -u '+%Y-%m-%dT%H:%M:%SZ'` 的 UTC 时间戳。 */
export function utcTimestamp(ts: Date): string {
  return ts.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * 递归列出 staging 内的文件（相对路径，不排序；排序由 {@link renderChecksums}
 * 与 manifest 各自的调用点决定）。
 */
export async function listFiles(
  dir: string,
  base = "",
): Promise<string[]> {
  const out: string[] = [];
  const entries = await Array.fromAsync(Deno.readDir(dir));
  for (const entry of entries) {
    const rel = `${base}${entry.name}`;
    if (entry.isDirectory) {
      out.push(...await listFiles(join(dir, entry.name), `${rel}/`));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * 临时产物名（同目录，保证 `rename` 是原子提交而非跨设备拷贝）。
 *
 * 前缀是 `.` 开头，`list`/`prune` 不会把它当成快照（`snapshot-*` 匹配），
 * 且失败清理时有明确的识别标志。
 */
export function tempContainerPath(finalPath: string): string {
  return join(
    dirname(finalPath),
    `.nojbackup-${Deno.pid}-${crypto.randomUUID()}.tmp`,
  );
}
