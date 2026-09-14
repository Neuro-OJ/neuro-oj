/**
 * 题目统计的 DTO 契约与展示辅助。
 *
 * 放在 `utils/` 而非 composable 内：本仓库约定**纯逻辑与契约放 utils**
 * （可被 `deno task test` 直接断言），Nuxt 依赖（useApi）留在 composable 内。
 */

/** 公开统计：所有用户可见；竞赛进行中的题目通过率为 null。 */
export interface PublicProblemStats {
  attempt_count: number;
  submit_count: number;
  accepted_count: number;
  /** 通过率（0-1）；竞赛进行中时为 null。 */
  acceptance_rate: number | null;
  /** 通过率被抑制的原因；未抑制时为 null。 */
  suppressed_reason: 'running_contest' | null;
}

/** 出题人统计：仅题目 owner 与管理员可见。 */
export interface ProblemStatsDetail extends PublicProblemStats {
  status_distribution: Record<string, number>;
  case_failure_distribution: Array<{
    case_id: string;
    failed: number;
    hidden: boolean;
  }>;
  first_ac_median_ms: number | null;
  sample_size: number;
  truncated: boolean;
  window_days: number;
}

/** 评测状态分布：按次数降序，便于一眼看出主要失败原因。 */
export function sortedStatusDistribution(
  entry: Record<string, number>,
): Array<[string, number]> {
  return Object.entries(entry).sort((a, b) => b[1] - a[1]);
}

/** 用例失败分布取前 N 条（后端已按失败次数降序）。 */
export function topFailedCases(
  entry: ProblemStatsDetail['case_failure_distribution'],
  limit = 10,
): ProblemStatsDetail['case_failure_distribution'] {
  return entry.slice(0, limit);
}

/**
 * 计算条形宽度百分比（按最大失败数归一化）。
 *
 * 最小宽度 4%：失败 1 次的用例若宽度为 0 会看起来"没有数据"。
 * 上限 100%：空列表时 `Math.max(1, ...[])` 为 1，会把传入值放大成 >100%
 * （如 5 → 500%）而溢出容器。
 */
export function caseBarWidth(
  failed: number,
  list: ProblemStatsDetail['case_failure_distribution'],
): string {
  const max = Math.max(1, ...list.map((item) => item.failed));
  const percent = Math.min(100, Math.round((failed / max) * 100));
  return `${Math.max(4, percent)}%`;
}

/**
 * 首次通过中位耗时的展示文案。
 *
 * @param ms 毫秒；null 表示无通过记录。
 * @returns 形如「12.3s」；无数据时为「—」而非「0s」（避免误读为"立刻通过"）。
 */
export function formatFirstAcMedian(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 公开通过率的展示文案。
 *
 * 三种状态必须区分清楚：赛中抑制（说明原因）、无提交（占位）、正常（数值）。
 *
 * @param stats 公开统计；未加载时传 null。
 * @returns 展示文案；未加载时为 null（调用方据此不渲染）。
 */
export function describeAcceptance(stats?: PublicProblemStats | null): string | null {
  if (!stats) return null;
  if (stats.suppressed_reason === 'running_contest') {
    return '竞赛进行中，暂不显示通过率';
  }
  if (stats.submit_count === 0) return '暂无通过记录';
  const rate = ((stats.acceptance_rate ?? 0) * 100).toFixed(1);
  return `通过率 ${rate}% · ${stats.accepted_count}/${stats.submit_count}`;
}
