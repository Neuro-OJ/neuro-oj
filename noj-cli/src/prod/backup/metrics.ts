/**
 * 备份新鲜度指标（node_exporter textfile collector）。
 *
 * ## 为什么需要
 *
 * `deploy/monitoring/noj-alerts.yml` 有三条告警直接依赖这些指标：
 * - `NojBackupStale`（>25h，warning）
 * - `NojBackupVeryStale`（>49h，critical）
 * - `NojBackupMetricMissing`（`absent(...)`，warning）
 *
 * 它们原先由 `backup.sh:209-221` 写入。TS 重写后**没有任何写入方**——
 * 即"迁移不完整"：脚本一旦删除，三条告警同时失去数据源，其中
 * `absent(...)` 那条会**持续报警**（而它恰恰是"备份从未成功"的信号，
 * 长期误报会让人忽略真正的备份故障）。
 *
 * ## 语义（与 drill 的 writer 一致，逐条对照 bash）
 *
 * - **只在成功时写**：告警语义是"最近一次**成功**距今多久"。
 *   失败也写会让"备份一直没成功"被掩盖——那正是该告警要抓的。
 * - 文件名 `noj_backup.prom`；目录缺省 `<backupDir>/metrics`
 *   （`NOJ_BACKUP_METRICS_DIR` 可覆盖，bash :209）；
 * - 文件 **644**、目录 **755**：node_exporter 以另一用户运行，必须可读；
 *   这两个权限是**代码设定的**，不依赖调用方 umask（否则同一命令在不同环境下
 *   产出不同可读性）。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §8.2 多副本约束）。
 */

import { join } from "@std/path";

/** 指标文件名（bash `metrics_file` 的 basename 逐字）。 */
export const BACKUP_METRICS_FILE = "noj_backup.prom";

/** 成功备份时间戳（Unix 秒）。告警表达式按此名匹配，**不可改名**。 */
export const METRIC_BACKUP_LAST_SUCCESS = "noj_backup_last_success_unix_time";

/** 快照字节数。告警规则虽未直接用，但 bash 会写，保留以维持可观测面。 */
export const METRIC_BACKUP_BYTES = "noj_backup_snapshot_bytes";

/**
 * 渲染指标正文（bash :213-218 的等价）。
 *
 * 保留 `# HELP` / `# TYPE` 注释：Prometheus 文本格式要求，且 bash 也写了。
 */
export function renderBackupMetrics(
  unixSeconds: number,
  snapshotBytes: number,
): string {
  return [
    `# HELP ${METRIC_BACKUP_LAST_SUCCESS} 最近一次成功备份的 Unix 时间戳。`,
    `# TYPE ${METRIC_BACKUP_LAST_SUCCESS} gauge`,
    `${METRIC_BACKUP_LAST_SUCCESS} ${unixSeconds}`,
    `# HELP ${METRIC_BACKUP_BYTES} 最近一次成功备份的快照字节数。`,
    `# TYPE ${METRIC_BACKUP_BYTES} gauge`,
    `${METRIC_BACKUP_BYTES} ${snapshotBytes}`,
  ].join("\n") + "\n";
}

/** {@link writeBackupMetrics} 的注入点。 */
export interface WriteBackupMetricsOptions {
  /** 备份目录（缺省在其下建 `metrics/`）。 */
  backupDir: string;
  /** 显式指标目录（`NOJ_BACKUP_METRICS_DIR`）；给出时优先。 */
  explicitDir?: string;
  /** 成功时间（Unix 秒）。 */
  unixSeconds: number;
  /** 快照字节数。 */
  snapshotBytes: number;
}

/**
 * 写入备份新鲜度指标，返回实际写入的目录。
 *
 * 调用方**只在备份成功后**调用（见文件头"只在成功时写"）。
 * 写失败会抛出——静默吞掉会让"指标缺失"变成无声故障，
 * 而监控恰恰是最后一道防线。
 */
export async function writeBackupMetrics(
  opts: WriteBackupMetricsOptions,
): Promise<string> {
  const dir = opts.explicitDir !== undefined && opts.explicitDir !== ""
    ? opts.explicitDir
    : join(opts.backupDir, "metrics");
  await Deno.mkdir(dir, { recursive: true, mode: 0o755 });
  // umask 会让 mkdir 的 mode 变窄，显式 chmod 保证 755（与 bash `mkdir -m 755` 同义）。
  await Deno.chmod(dir, 0o755).catch(() => {});
  const file = join(dir, BACKUP_METRICS_FILE);
  await Deno.writeTextFile(
    file,
    renderBackupMetrics(opts.unixSeconds, opts.snapshotBytes),
  );
  // 同上：WriteTextFile 的权限受 umask 影响，显式设定（bash `chmod 644`）。
  await Deno.chmod(file, 0o644);
  return dir;
}
