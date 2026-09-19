/**
 * 备份目录的列举与清理（#515 P6）。
 *
 * 与 backup_index.ts（纯逻辑）分离：本文件触碰文件系统，便于纯逻辑保持可单测。
 *
 * **向后兼容（issue 硬要求）**：必须识别并处理存量 snapshot-* 目录格式，
 * 否则存量备份既无法列举也无法恢复。
 */
import {
  detectSnapshotFormat,
  parseBackupName,
  planPrune,
  type PruneOptions,
  type PrunePlan,
  type SnapshotEntry,
} from "./index.ts";

/** 列举结果。 */
export interface ListResult {
  entries: SnapshotEntry[];
  /** 无法识别格式而被忽略的条目（供 --json 诊断）。 */
  ignored: string[];
}

/** 目录字节大小（递归求和）。 */
async function dirSize(path: string): Promise<number> {
  let total = 0;
  try {
    for await (const e of Deno.readDir(path)) {
      const full = path + "/" + e.name;
      if (e.isDirectory) total += await dirSize(full);
      else if (e.isFile) total += (await Deno.stat(full)).size;
    }
  } catch {
    // 无权限/竞态：返回已累计值
  }
  return total;
}

/**
 * 列举备份目录下的全部备份产物（单文件 + 旧目录）。
 *
 * **不解包**：单文件用文件大小，旧目录递归求和；时间从名字解析。
 * 满足 issue 的「无需解包即可显示时间/大小」。
 */
export async function listBackups(backupDir: string): Promise<ListResult> {
  const entries: SnapshotEntry[] = [];
  const ignored: string[] = [];

  const dirEntries: Deno.DirEntry[] = [];
  try {
    for await (const e of Deno.readDir(backupDir)) dirEntries.push(e);
  } catch {
    // 备份目录不存在：视为空列表（首次使用是正常情况）
    return { entries, ignored };
  }

  for (const e of dirEntries) {
    let inner: string[] | undefined;
    if (e.isDirectory) {
      inner = [];
      try {
        for await (const c of Deno.readDir(backupDir + "/" + e.name)) {
          inner.push(c.name);
        }
      } catch {
        inner = [];
      }
    }
    const format = detectSnapshotFormat({
      name: e.name,
      isDir: e.isDirectory,
      entries: inner,
    });
    if (format === "unknown") {
      ignored.push(e.name);
      continue;
    }
    const path = backupDir + "/" + e.name;
    const parsed = parseBackupName(e.name);
    entries.push({
      name: e.name,
      path,
      // 无法解析时间时用 epoch：排序会被排到最后（视为最旧），
      // 避免坏名字的条目被误当成最新而躲过 prune。
      createdAt: (parsed ?? new Date(0)).toISOString(),
      bytes: e.isDirectory ? await dirSize(path) : (await Deno.stat(path)).size,
      format,
    });
  }

  entries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { entries, ignored };
}

/** prune 执行结果。 */
export interface PruneResult {
  plan: PrunePlan;
  /** 实际删除的路径（dry-run 时为空）。 */
  deleted: string[];
  /**
   * 删除失败的条目与原因（评审修正）。
   *
   * 早先 `catch {}` 静默吞掉失败，调用方只看到 "已删除 0 个" 却 exit 0——
   * 向用户传达了"已清理"的**假成功**，恰恰破坏 prune 的安全价值。
   * 删除失败必须被上报（调用方据此返回非零退出码）。
   */
  failed: Array<{ path: string; reason: string }>;
}

/**
 * 按计划清理备份。
 *
 * **默认 dry-run**（issue 要求）：confirm 为 false 时只返回计划，
 * 不做任何删除。confirm: true 才真正删除。
 */
export async function pruneBackups(
  backupDir: string,
  options: PruneOptions & { confirm?: boolean },
): Promise<PruneResult> {
  const { entries } = await listBackups(backupDir);
  const plan = planPrune(entries, options);
  if (!options.confirm) {
    return { plan, deleted: [], failed: [] };
  }
  const deleted: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  for (const entry of plan.remove) {
    try {
      await Deno.remove(entry.path, { recursive: entry.format === "legacy" });
      deleted.push(entry.path);
    } catch (e) {
      // 不阻断其余条目，但**必须记录**（否则调用方会报出假成功）
      failed.push({ path: entry.path, reason: (e as Error).message });
    }
  }
  return { plan, deleted, failed };
}
