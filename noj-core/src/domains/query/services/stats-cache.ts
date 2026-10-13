import { sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import { todayUtc } from "../../../shared/base/dates.ts";
import { unifiedSubmissionSources } from "../../../shared/versioning/submission-sources.ts";
import { Channels, publishSseEvent } from "../../../shared/sse/event-bus.ts";
import { DEFAULT_DOMAIN_ID } from "../../workspace/index.ts";
import {
  type DomainQueryScope,
  PUBLIC_DEFAULT_QUERY_SCOPE,
  submissionQueryVisibility,
} from "./domain-query.ts";

/** 提交统计快照，满分数采用当前有效成绩。 */
export interface StatsSnapshot {
  total: number;
  full_score: number;
  not_full_score: number;
}

/** 源共享授权会即时变化，不能从缺少授权revision的旧Redis键恢复统计。 */
export async function getDomainSubmissionStats(
  scope: DomainQueryScope,
  today = false,
  userId?: string,
): Promise<StatsSnapshot> {
  const result = await getDb().execute(sql`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE s.is_valid AND a.score>=10000)::int AS full_score
    FROM (SELECT * FROM ${unifiedSubmissionSources}) s
    LEFT JOIN evaluation_attempts a ON a.id=s.effective_attempt_id
    WHERE ${
    submissionQueryVisibility(scope, {
      domainId: sql`s.domain_id`,
      bindingId: sql`s.domain_problem_binding_id`,
      contestId: sql`s.contest_id`,
    })
  }
      ${today ? sql`AND s.created_at>=${todayUtc()}` : sql``}
      ${userId ? sql`AND s.user_id=${userId}` : sql``}`);
  const [row] = unwrapRows<{ total: number; full_score: number }>(
    result as never,
  );
  return { ...row, not_full_score: row.total - row.full_score };
}
/** 默认域累计统计保留原API名称，读取当前数据库事实。 */
export function getCachedTotalStats(): Promise<StatsSnapshot> {
  return getDomainSubmissionStats(PUBLIC_DEFAULT_QUERY_SCOPE);
}
/** 默认域今日统计；本人过滤同样不会混入其他域活动。 */
export function getCachedTodayStats(userId?: string): Promise<StatsSnapshot> {
  return getDomainSubmissionStats(PUBLIC_DEFAULT_QUERY_SCOPE, true, userId);
}
/** 结果变更只发送所属域的定位事件，不广播私有活动给公共统计订阅。 */
export function applyNewResult(domainId = DEFAULT_DOMAIN_ID): void {
  void publishSseEvent(
    domainId === DEFAULT_DOMAIN_ID
      ? Channels.stats
      : `noj:events:domain:${domainId}:stats`,
    { type: "stats:updated" },
  );
}
/** 当前实现无统计缓存，保留测试入口。 */
export function _resetStatsCacheForTest(): void {}
