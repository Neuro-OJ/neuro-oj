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
  evaluationAttempts,
  queryProjectionRevisions,
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

/** 公开统计：所有用户可见；竞赛进行中的题目隐藏难度先验。 */
export interface PublicProblemStats {
  attempt_count: number;
  /** 提交总数；竞赛进行中时为 null（与 `acceptance_rate` 同步抑制，防算术还原）。 */
  submit_count: number | null;
  /**
   * 当前口径下**有效**的提交数（已产生正式判定）；公开通过率的分母。
   * 竞赛进行中时为 null（与 `acceptance_rate` 同步抑制）。
   */
  valid_submissions: number | null;
  /** 通过数；竞赛进行中时为 null（与 `acceptance_rate` 同步抑制，防算术还原）。 */
  accepted_count: number | null;
  /** 通过率（0-1）；竞赛进行中时为 null。 */
  acceptance_rate: number | null;
  /** 通过率被抑制的原因；未抑制时为 null。 */
  suppressed_reason: "running_contest" | null;
}

/** 出题人统计：仅题目 owner 与管理员可见（不受赛期抑制影响）。 */
export interface ProblemStatsDetail {
  attempt_count: number;
  submit_count: number;
  /** 当前口径下有效的提交数（公开通过率分母，§3.4）。 */
  valid_submissions: number;
  accepted_count: number;
  acceptance_rate: number | null;
  suppressed_reason: "running_contest" | null;
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
const statsCache = new Map<
  string,
  { at: number; revision: number; value: ProblemStatsDetail }
>();

/**
 * 读取题目作用域的投影 revision。
 *
 * 统计缓存**必须**带上 revision：策略切换（`exact(X)`）会立刻改变"有效提交"集合，
 * 只用 TTL 会让后台看到旧口径（Handbook §3.5「策略立即生效不能依赖 TTL」）。
 */
async function loadProblemProjectionRevision(
  problemId: string,
): Promise<number> {
  const [row] = await getDb().select({
    data_revision: queryProjectionRevisions.data_revision,
  }).from(queryProjectionRevisions).where(
    eq(queryProjectionRevisions.scope_key, `problem:${problemId}`),
  ).limit(1);
  return Number(row?.data_revision ?? 0);
}

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
  const revision = await loadProblemProjectionRevision(problemId);
  const cached = statsCache.get(problemId);
  if (
    cached &&
    cached.revision === revision &&
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
  // 读**有效成绩**（§3.2/§3.4）：分数/状态/详情取有效尝试，
  // 是否通过与"有效提交"口径直接读投影（策略切换后立即生效）。
  const rows = await db
    .select({
      user_id: submissions.user_id,
      created_at: submissions.created_at,
      status: evaluationAttempts.result_status,
      score: evaluationAttempts.score,
      details: evaluationAttempts.details,
      is_accepted: submissions.is_accepted,
      is_valid: submissions.is_valid,
    })
    .from(submissions)
    .innerJoin(
      evaluationAttempts,
      eq(evaluationAttempts.id, submissions.effective_attempt_id),
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
  /** 当前口径下有效的提交数（公开通过率分母，§3.4）。 */
  let validCount = 0;

  // 正序遍历（rows 为 created_at 降序，故反转后即为时间升序），
  // 以便把每个用户的首次提交时间与首次 AC 时间都取到"最早"的那次。
  for (const row of [...sample].reverse()) {
    const submittedAt = Date.parse(row.created_at);
    if (Number.isFinite(submittedAt) && !firstSubmitAt.has(row.user_id)) {
      firstSubmitAt.set(row.user_id, submittedAt);
    }

    const status = row.status ?? "unknown";
    statusDistribution[status] = (statusDistribution[status] ?? 0) + 1;
    if (row.is_valid) validCount += 1;
    if (row.is_accepted) {
      acceptedCount += 1;
      if (Number.isFinite(submittedAt) && !firstAcAt.has(row.user_id)) {
        firstAcAt.set(row.user_id, submittedAt);
      }
    }

    let parsed: unknown;
    try {
      // `evaluation_attempts.details` 是 JSONB（对象），`evaluation_results.details`
      // 是文本；兼容两种形态，避免迁移期读不到用例分布。
      parsed = typeof row.details === "string"
        ? JSON.parse(row.details)
        : row.details;
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
    // 有效成绩口径：分母是"当前有效、已产生正式判定"的提交数（§3.4）
    valid_submissions: validCount,
    accepted_count: acceptedCount,
    acceptance_rate: validCount === 0 ? 0 : acceptedCount / validCount,
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

  statsCache.set(problemId, { at: Date.now(), revision, value });
  return value;
}

/**
 * 公开统计：竞赛进行中的题目隐藏难度先验，其余字段照常返回。
 *
 * 理由：通过率是"这题有多难"的信号，赛期公开等于给出题目难度先验。
 *
 * **为何连 `accepted_count` / `submit_count` 一起抑制**（2026-09-14 评审 C2）：
 * 通过率恰为 `accepted_count / submit_count`。若只把 `acceptance_rate` 置 null 而
 * 照常返回这两个整数，被扣留的先验可以**算术还原**——抑制形同虚设。故赛期三者
 * 一并置 null，调用方无法从任何组合反推通过率。
 *
 * @param problemId 题目 UUID。
 * @returns 公开统计；赛期 `acceptance_rate` / `accepted_count` / `submit_count`
 *          均为 null，且 `suppressed_reason` 说明原因。
 */
export async function getPublicProblemStats(
  problemId: string,
): Promise<PublicProblemStats> {
  const detail = await getProblemStatsDetail(problemId);
  const suppressed = await isProblemInRunningContest(problemId);
  return {
    attempt_count: detail.attempt_count,
    submit_count: suppressed ? null : detail.submit_count,
    valid_submissions: suppressed ? null : detail.valid_submissions,
    accepted_count: suppressed ? null : detail.accepted_count,
    acceptance_rate: suppressed ? null : detail.acceptance_rate,
    suppressed_reason: suppressed ? "running_contest" : null,
  };
}
