/**
 * 题目统计聚合：公开通过率 + 出题人数据洞察。
 *
 * 口径约定（设计 spec §5.4/§5.5）：
 * - 仅统计 `submissions.status = 'finished'` 且有评测结果的提交；
 * - 隐藏用例只进**匿名聚合桶**（`hidden-1`、`hidden-2`…），**绝不返回真实 case_id**；
 * - 取数上限 `MAX_STATS_SAMPLE`，超出返回 `truncated = true`（**不静默截断**）。
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import {
  evaluationResults,
  submissions,
} from "./../../../../shared/db/schema.ts";
import { isProblemInRunningContest } from "./../../../contest/index.ts";

/**
 * 单次聚合的提交样本上限。
 *
 * 超限时返回 `truncated = true` 而非静默截断：对洞察类功能，
 * 静默截断会让"没算到"被误读成"没问题"（与竞赛相似度检测的既有取舍一致）。
 */
export const MAX_STATS_SAMPLE = 2000;

/** 统计缓存的默认有效期（毫秒）。 */
export const STATS_CACHE_TTL_MS = 5 * 60 * 1000;

/** 公开统计：所有用户可见；竞赛进行中的题目隐藏通过率。 */
export interface PublicProblemStats {
  attempt_count: number;
  submit_count: number;
  accepted_count: number;
  /** 通过率（0-1）；竞赛进行中时为 null。 */
  acceptance_rate: number | null;
  /** 通过率被抑制的原因；未抑制时为 null。 */
  suppressed_reason: "running_contest" | null;
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

/**
 * 进程内统计缓存（5 分钟 TTL）。
 *
 * **单副本专用**：多副本部署下各副本各自缓存，最多 5 分钟内可能读到旧统计。
 * 已登记于 `dev-docs/engineering/domain-boundaries.md` 的多副本约束表。
 */
const statsCache = new Map<string, { at: number; value: ProblemStatsDetail }>();

/** 测试用：清空统计缓存，避免用例间互相污染。 */
export function _resetProblemStatsCacheForTest(): void {
  statsCache.clear();
}

/**
 * 判定用例是否为隐藏用例。
 *
 * 与 `submission-projection.ts` 的 `isHidden` 保持同一口径
 * （`hidden === true` 或 `visibility === "hidden"`），避免两处判定分叉。
 */
function isHiddenCase(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.hidden === true) return true;
  return record.visibility === "hidden";
}

/**
 * 计算中位数（偶数个样本取中间两数均值并取整）。
 *
 * @param values 数值列表。
 * @returns 中位数；空列表返回 null（调用方据此显示占位而非 0）。
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * 拉取题目统计样本并按窗口聚合。
 *
 * @param problemId 题目 UUID。
 * @param windowDays 统计窗口天数（默认 90）；仅统计该窗口内的提交。
 * @returns 聚合结果；缓存命中时直接返回缓存值。
 */
export async function getProblemStatsDetail(
  problemId: string,
  windowDays = 90,
): Promise<ProblemStatsDetail> {
  const cached = statsCache.get(problemId);
  if (
    cached &&
    Date.now() - cached.at < STATS_CACHE_TTL_MS &&
    cached.value.window_days === windowDays
  ) {
    return cached.value;
  }

  const since = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const db = getDb();
  // 只取聚合所需字段（不含 code），避免把用户源码拉进内存
  const rows = await db
    .select({
      user_id: submissions.user_id,
      created_at: submissions.created_at,
      status: evaluationResults.status,
      score: evaluationResults.score,
      details: evaluationResults.details,
    })
    .from(submissions)
    .innerJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    )
    .where(and(
      eq(submissions.problem_id, problemId),
      eq(submissions.status, "finished"),
      gte(submissions.created_at, since),
    ))
    .orderBy(desc(submissions.created_at))
    .limit(MAX_STATS_SAMPLE + 1);

  const truncated = rows.length > MAX_STATS_SAMPLE;
  const sample = truncated ? rows.slice(0, MAX_STATS_SAMPLE) : rows;

  const statusDistribution: Record<string, number> = {};
  const caseFailures = new Map<string, { failed: number; hidden: boolean }>();
  /** 隐藏用例真实 id → 匿名别名；按首次出现顺序稳定分配。 */
  const hiddenAliases = new Map<string, string>();
  const firstAcAt = new Map<string, number>();
  const firstSubmitAt = new Map<string, number>();
  let acceptedCount = 0;

  // 正序遍历（rows 为 created_at 降序，故反转后即为时间升序），
  // 以便把每个用户的首次提交时间与首次 AC 时间都取到"最早"的那次。
  for (const row of [...sample].reverse()) {
    const submittedAt = Date.parse(row.created_at);
    if (Number.isFinite(submittedAt) && !firstSubmitAt.has(row.user_id)) {
      firstSubmitAt.set(row.user_id, submittedAt);
    }

    const status = row.status ?? "unknown";
    statusDistribution[status] = (statusDistribution[status] ?? 0) + 1;
    if (row.status === "finished" && row.score > 0) {
      acceptedCount += 1;
      if (Number.isFinite(submittedAt) && !firstAcAt.has(row.user_id)) {
        firstAcAt.set(row.user_id, submittedAt);
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.details);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const cases = (parsed as { cases?: unknown }).cases;
    if (!Array.isArray(cases)) continue;
    for (const entry of cases) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const caseStatus = typeof record.status === "string" ? record.status : "";
      if (caseStatus === "Accepted") continue;

      const hidden = isHiddenCase(entry);
      const realId = typeof record.case_id === "string"
        ? record.case_id
        : `unknown-${caseFailures.size}`;
      // 隐藏用例匿名化：真实 id 只用于内部去重，绝不进入返回值
      const key = hidden
        ? (hiddenAliases.get(realId) ??
          `hidden-${hiddenAliases.size + 1}`)
        : realId;
      if (hidden && !hiddenAliases.has(realId)) {
        hiddenAliases.set(realId, key);
      }
      const current = caseFailures.get(key);
      if (current) current.failed += 1;
      else caseFailures.set(key, { failed: 1, hidden });
    }
  }

  const firstAcDurations: number[] = [];
  for (const [userId, acAt] of firstAcAt) {
    const firstAt = firstSubmitAt.get(userId);
    if (firstAt !== undefined && acAt >= firstAt) {
      firstAcDurations.push(acAt - firstAt);
    }
  }

  const value: ProblemStatsDetail = {
    attempt_count: firstSubmitAt.size,
    submit_count: sample.length,
    accepted_count: acceptedCount,
    acceptance_rate: sample.length === 0 ? 0 : acceptedCount / sample.length,
    suppressed_reason: null,
    status_distribution: statusDistribution,
    case_failure_distribution: [...caseFailures.entries()]
      .map(([case_id, info]) => ({
        case_id,
        failed: info.failed,
        hidden: info.hidden,
      }))
      .sort((a, b) => b.failed - a.failed),
    first_ac_median_ms: median(firstAcDurations),
    sample_size: sample.length,
    truncated,
    window_days: windowDays,
  };

  statsCache.set(problemId, { at: Date.now(), value });
  return value;
}

/**
 * 公开统计：竞赛进行中的题目隐藏通过率，其余字段照常返回。
 *
 * 理由：通过率是"这题有多难"的信号，赛期公开等于给出题目难度先验；
 * 提交数本身不构成榜单优势，故不抑制。
 *
 * @param problemId 题目 UUID。
 * @returns 公开统计；赛期 `acceptance_rate` 为 null 且 `suppressed_reason` 说明原因。
 */
export async function getPublicProblemStats(
  problemId: string,
): Promise<PublicProblemStats> {
  const detail = await getProblemStatsDetail(problemId);
  const suppressed = await isProblemInRunningContest(problemId);
  return {
    attempt_count: detail.attempt_count,
    submit_count: detail.submit_count,
    accepted_count: detail.accepted_count,
    acceptance_rate: suppressed ? null : detail.acceptance_rate,
    suppressed_reason: suppressed ? "running_contest" : null,
  };
}
