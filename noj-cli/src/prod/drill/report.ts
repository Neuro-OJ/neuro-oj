/**
 * 演练报告与监控指标（T19）。
 *
 * 迁移 `restore-drill.sh` 的 `write_report()`（:521-564）、`write_failure_report()`
 * （:187-207）、`write_drill_metrics()`（:565-575）、`snapshot_created_at()`
 * （:502-511）与 `hours_since_snapshot()`（:512-520）。
 *
 * ## 为什么字段名必须逐字保持
 *
 * 报告是**运维与人（以及告警）的接口**：`deploy/monitoring/noj-alerts.yml:236`
 * 引用指标名，外部脚本与 runbook 引用报告字段。移植时改字段名等于悄悄破坏
 * 这些消费方——而它们不在本仓库的测试覆盖里（`check-runbooks.ts` 只做静态检查）。
 * 因此本模块用**逐字常量**而非"更优雅的命名"，并由测试逐字段断言。
 *
 * ## 报告与指标的分工
 *
 * - **报告**（`restore-drill-report.txt`，权限 600）：人读，含全部上下文
 *   （快照时间、RPO/RTO 目标与实际、数据核对明细、验收日志、清理状态）。
 *   权限 600 是必要的：验收日志可能含题目 ID 与内部 URL。
 * - **指标**（`noj_restore_drill.prom`，权限 644）：机器读，**只在成功时写**。
 *   "失败时也写"会让告警失去意义——告警的语义是"最近一次成功距今多久"。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §8.2 多副本约束）：只有纯渲染函数。
 */

import { dirname, join } from "@std/path";

/** 报告文件名（bash :297）。 */
export const REPORT_FILE_NAME = "restore-drill-report.txt";

/** 指标文件名（bash :572）。 */
export const DRILL_METRICS_FILE = "noj_restore_drill.prom";

/**
 * 演练指标名（**逐字保持**，spec §3.4 契约）。
 *
 * 被 `deploy/monitoring/noj-alerts.yml:236` 直接引用：
 * `time() - noj_restore_drill_last_success_unix_time > 7776000`（90 天）。
 * 改名 = 静默让该告警永久失效（`absent()` 只在 missing 时告警，而改名后
 * 新名字存在、旧名字消失，若告警写的是旧名字则变成 absent 分支）。
 */
export const METRIC_LAST_SUCCESS = "noj_restore_drill_last_success_unix_time";

/** 演练类型标记（bash :527，报告与失败报告共用）。 */
export const DRILL_TYPE = "isolated-restore-with-business-verification";

/** 凭据提示（bash :559 逐字）。 */
export const CREDENTIAL_NOTE =
  "备份快照与 GPG 口令文件应异地独立保存；口令丢失即无法恢复。";

/** {@link renderReport} 的输入。 */
export interface ReportInput {
  /** `passed` 或 `passed_with_warnings`（RPO/RTO 超限时后者）。 */
  result: "passed" | "passed_with_warnings";
  snapshot: string;
  /** 快照 manifest 的 `created_at`（缺失时空串）。 */
  snapshotCreatedAt: string;
  drillStartedAt: string;
  drillFinishedAt: string;
  restoreDurationSeconds: number;
  totalDurationSeconds: number;
  /** 距快照创建的小时数（两位小数）。 */
  rpoHours: string;
  rpoTargetHours: number;
  rpoMet: boolean;
  rtoMinutes: number;
  rtoTargetMinutes: number;
  rtoMet: boolean;
  composeProject: string;
  networkSubnet: string;
  /** 数据核对明细（`restore_data_check=passed` 等，来自 {@link renderChecks}）。 */
  checks: string;
  /** 业务验收日志（原始行，含 JSON 与人类文字）。 */
  verifyLog: string;
  /** `kept-for-review` 或 `done`。 */
  cleanup: "kept-for-review" | "done";
}

/** 渲染成功报告（bash `write_report` :521-564 的等价）。 */
export function renderReport(input: ReportInput): string {
  const lines = [
    `result=${input.result}`,
    `drill_type=${DRILL_TYPE}`,
    `snapshot=${input.snapshot}`,
    `snapshot_created_at=${input.snapshotCreatedAt}`,
    `drill_started_at=${input.drillStartedAt}`,
    `drill_finished_at=${input.drillFinishedAt}`,
    `restore_duration_seconds=${input.restoreDurationSeconds}`,
    `total_duration_seconds=${input.totalDurationSeconds}`,
    `rpo_hours=${input.rpoHours}`,
    `rpo_target_hours=${input.rpoTargetHours}`,
    `rpo_met=${input.rpoMet}`,
    `rto_minutes=${input.rtoMinutes}`,
    `rto_target_minutes=${input.rtoTargetMinutes}`,
    `rto_met=${input.rtoMet}`,
    `compose_project=${input.composeProject}`,
    `network_subnet=${input.networkSubnet}`,
  ];
  if (input.checks !== "") lines.push(input.checks.replace(/\n+$/, ""));
  if (input.verifyLog !== "") {
    lines.push("# ---- 业务验收明细 ----");
    lines.push(input.verifyLog.replace(/\n+$/, ""));
  }
  lines.push(`cleanup=${input.cleanup}`);
  lines.push(`credential_note=${CREDENTIAL_NOTE}`);
  return lines.join("\n") + "\n";
}

/** {@link renderFailureReport} 的输入。 */
export interface FailureReportInput {
  snapshot: string;
  /** 失败的阶段名（`preflight`/`restore-data`/`business-verify`…）。 */
  failedStage: string;
  drillStartedAt: string;
  composeProject: string;
  /** 失败现场：验收日志尾部（bash 取最后 50 行）。 */
  verifyLogTail: string;
  cleanup: "kept-for-review" | "done";
}

/**
 * 渲染失败报告（bash `write_failure_report` :187-207 的等价）。
 *
 * 与成功报告**不同**的字段集：没有 RPO/RTO 与时长（那些在失败时没有意义，
 * 硬填会让人误读为"跑完了"），但有 `failed_stage`（定位失败位置）。
 * `preflight` 阶段不写报告（bash 同样 `return 0`）——那时报告路径可能都还没定。
 */
export function renderFailureReport(input: FailureReportInput): string {
  const lines = [
    "result=failed",
    `drill_type=${DRILL_TYPE}`,
    `snapshot=${input.snapshot}`,
    `failed_stage=${input.failedStage}`,
    `drill_started_at=${input.drillStartedAt || "unknown"}`,
    `compose_project=${input.composeProject}`,
  ];
  if (input.verifyLogTail !== "") {
    lines.push("# ---- 业务验收输出（失败现场） ----");
    lines.push(input.verifyLogTail.replace(/\n+$/, ""));
  }
  lines.push(`cleanup=${input.cleanup}`);
  lines.push(`credential_note=${CREDENTIAL_NOTE}`);
  return lines.join("\n") + "\n";
}

/** 数据核对明细的输入（bash `verify_data` :416-423 的 `checks.env`）。 */
export interface ChecksInput {
  restoredUserCount: number;
  restoredRedisKeys: number;
  snapshotObjectCount: number;
  restoredObjectCount: number;
}

/** 渲染 `checks.env` 段（bash :416-423 逐字）。 */
export function renderChecks(input: ChecksInput): string {
  return [
    "restore_data_check=passed",
    `restored_user_count=${input.restoredUserCount}`,
    `restored_redis_keys=${input.restoredRedisKeys}`,
    `snapshot_object_count=${input.snapshotObjectCount}`,
    `restored_object_count=${input.restoredObjectCount}`,
  ].join("\n");
}

/**
 * 渲染演练指标正文（bash `write_drill_metrics` :565-575 的等价）。
 *
 * **只在成功时调用**（编排层保证）：告警语义是"最近一次成功距今多久"，
 * 失败也写会让"演练一直没成功"这件事被掩盖——那正是该告警要抓的。
 */
export function renderDrillMetrics(unixSeconds: number): string {
  return [
    `# HELP ${METRIC_LAST_SUCCESS} 最近一次隔离恢复演练成功的 Unix 时间戳。`,
    `# TYPE ${METRIC_LAST_SUCCESS} gauge`,
    `${METRIC_LAST_SUCCESS} ${unixSeconds}`,
  ].join("\n") + "\n";
}

/** 指标目录（bash :566：`NOJ_BACKUP_METRICS_DIR` 或快照同级的 `metrics/`）。 */
export function metricsDirOf(
  snapshotPath: string,
  explicit: string | undefined,
): string {
  if (explicit !== undefined && explicit !== "") return explicit;
  return join(dirname(snapshotPath.replace(/\/+$/, "")), "metrics");
}

/**
 * 从 manifest.json 提取 `created_at`（bash `snapshot_created_at` :502-511 的等价）。
 *
 * bash 用 `awk` 在 JSON 文本上做正则；这里用 `JSON.parse`（更可靠），
 * 但**保持宽容**：解析失败或字段缺失时返回空串，而不是抛错——RPO 计算会据此
 * 记为"无法判定"（`rpo_met=false` 的反面：bash 的 `date -d ""` 得到 0，
 * 从而 `hours_since_snapshot` 变成一个巨大值 → RPO 不达标）。
 *
 * 与 bash 的这点差异是**有意的**：见 {@link hoursSinceSnapshot}。
 */
export function snapshotCreatedAt(manifestText: string): string {
  try {
    const parsed = JSON.parse(manifestText) as { created_at?: unknown };
    return typeof parsed?.created_at === "string" ? parsed.created_at : "";
  } catch {
    return "";
  }
}

/**
 * 计算距快照创建的小时数（bash `hours_since_snapshot` :512-520 的等价）。
 *
 * **缺失/不可解析的时间戳 ⇒ `Infinity`**（即 RPO 必然不达标）。这与 bash 的
 * 实际行为一致（bash 在 `date` 解析失败时回退 `echo 0`，于是
 * `epoch_created=0`、`(now-0)/3600` 是个巨大值），但表达得更明确：
 * "无法判断快照有多旧"与"快照很旧"在 RPO 上应当**同样**不达标——一份时间戳
 * 损坏的备份不应因为解析失败而"通过"新鲜度检查。
 */
export function hoursSinceSnapshot(
  createdAt: string,
  now: Date,
): number {
  const parsed = Date.parse(createdAt);
  if (Number.isNaN(parsed)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - parsed) / 3_600_000;
}

/**
 * 格式化小时数（bash 的 `awk 'BEGIN { printf "%.2f" }'` 等价）。
 *
 * `Infinity` 会格式化成 `inf`——刻意不特判为数字：报告里出现 `inf` 明确表示
 * "时间戳不可用"，比伪装成一个具体小时数更诚实。
 */
export function formatHours(hours: number): string {
  return Number.isFinite(hours) ? hours.toFixed(2) : "inf";
}
