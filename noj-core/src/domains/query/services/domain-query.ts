import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import { domainProblemBindingAvailableWhere } from "../../catalog/index.ts";
import { DEFAULT_DOMAIN_ID, loadWorkspace } from "../../workspace/index.ts";
import { endedWindowCondition } from "../../contest/index.ts";
import { unifiedSubmissionSources } from "../../../shared/versioning/submission-sources.ts";
import type { RankingRow, RankingsPage } from "./rankings.ts";

/** 统计入口由明确网址重新解析的访问事实。 */
export interface DomainQueryScope {
  domainId: string;
  member: boolean;
}
/** 公共默认域口径，管理员或主页本人也不会聚合私有学校数据。 */
export const PUBLIC_DEFAULT_QUERY_SCOPE: Readonly<DomainQueryScope> = Object
  .freeze({ domainId: DEFAULT_DOMAIN_ID, member: false });
/** 显式域统计的当前成员权限，不能由客户端传入 domain ID 代替解析。 */
export async function loadDomainQueryScope(
  slug: string,
  actorId: string | null,
): Promise<DomainQueryScope> {
  const access = await loadWorkspace(slug, actorId);
  return {
    domainId: access.domain.id,
    member: !!access.membership || access.platformAdmin,
  };
}

/** 所有聚合在计数前使用同一域、绑定可用性与比赛公开窗口。 */
export function submissionQueryVisibility(
  scope: DomainQueryScope,
  columns: {
    domainId: AnyColumn | SQL;
    bindingId: AnyColumn | SQL;
    contestId: AnyColumn | SQL;
  },
) {
  return sql`coalesce(${columns.domainId},${DEFAULT_DOMAIN_ID})=${scope.domainId}
    AND (${columns.domainId} IS NULL OR EXISTS (SELECT 1 FROM domains query_domain
      WHERE query_domain.id=${scope.domainId} AND query_domain.status<>'suspended'
        AND (query_domain.configuration->>'access'='public' OR ${scope.member})))
    AND ((${columns.domainId} IS NULL AND ${columns.bindingId} IS NULL AND ${
    scope.domainId === DEFAULT_DOMAIN_ID
  })
      OR ${
    domainProblemBindingAvailableWhere(
      columns.bindingId,
      sql`${scope.domainId}`,
      { member: scope.member },
    )
  })
    AND (${columns.contestId} IS NULL OR EXISTS (SELECT 1 FROM contests visible_contest
      WHERE visible_contest.id=${columns.contestId}
      AND ${endedWindowCondition(sql`visible_contest.end_time`)}
      AND (${
    scope.domainId !== DEFAULT_DOMAIN_ID
  } OR visible_contest.affect_global_ranking=true)))`;
}

function visibleSources(scope: DomainQueryScope) {
  return sql`SELECT s.* FROM (SELECT * FROM ${unifiedSubmissionSources}) s
    WHERE ${
    submissionQueryVisibility(scope, {
      domainId: sql`s.domain_id`,
      bindingId: sql`s.domain_problem_binding_id`,
      contestId: sql`s.contest_id`,
    })
  }`;
}

/** 域榜的候选提交不跨域混用，并在分页前去除失效引用及赛中隐藏结果。 */
export async function getDomainRankingRows(
  scope: DomainQueryScope,
  params: { page: number; limit?: number; userId?: string },
): Promise<RankingsPage> {
  const limit = params.limit ?? 50;
  if (!Number.isInteger(params.page) || params.page < 1) {
    throw new BadRequestError("page 必须为正整数");
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new BadRequestError("limit 必须为正整数");
  }
  const size = Math.min(limit, 100), offset = (params.page - 1) * size;
  const result = await getDb().execute(
    sql`WITH visible_sources AS (${visibleSources(scope)}), aggregate AS (
    SELECT u.id AS user_id,u.username,u.avatar_url,u.created_at,
      count(*)::int AS total_submissions,count(*) FILTER (WHERE s.is_valid)::int AS valid_submissions,
      count(DISTINCT s.problem_id) FILTER (WHERE s.is_accepted)::int AS solved_count,
      CASE WHEN count(*) FILTER (WHERE s.is_valid)=0 THEN 0 ELSE round(
        count(*) FILTER (WHERE s.is_accepted)::numeric/count(*) FILTER (WHERE s.is_valid),3)::float END AS acceptance_rate
    FROM visible_sources s JOIN users u ON u.id=s.user_id
    WHERE u.id<>'0' AND u.deleted_at IS NULL
    GROUP BY u.id,u.username,u.avatar_url,u.created_at HAVING bool_or(s.is_accepted)
  ), ranked AS (
    SELECT *,row_number() OVER (ORDER BY solved_count DESC,acceptance_rate DESC,total_submissions ASC,created_at ASC,user_id ASC)::int AS rank FROM aggregate
  ) SELECT (SELECT count(*)::int FROM ranked) AS total,
    coalesce(json_agg(selected ORDER BY selected.rank),'[]'::json) AS data FROM (
      SELECT rank,user_id,username,avatar_url,solved_count,total_submissions,valid_submissions,acceptance_rate FROM ranked
      ${params.userId ? sql`WHERE user_id=${params.userId}` : sql``}
      ORDER BY rank LIMIT ${size} OFFSET ${offset}
    ) selected`,
  );
  const [row] = unwrapRows<{ total: number; data: RankingRow[] }>(
    result as never,
  );
  return { total: Number(row.total), data: row.data };
}

/** 当前域站点统计仅聚合获授权资源；源撤销不等待缓存或索引刷新。 */
export async function getDomainStats(scope: DomainQueryScope) {
  const result = await getDb().execute(
    sql`WITH visible_sources AS (${visibleSources(scope)}) SELECT
    (SELECT count(*)::int FROM domain_problem_bindings candidate_binding WHERE candidate_binding.domain_id=${scope.domainId}
      AND ${
      domainProblemBindingAvailableWhere(
        sql`candidate_binding.id`,
        sql`${scope.domainId}`,
        {
          member: scope.member,
        },
      )
    }) AS problems,
    count(*)::int AS submissions,count(*) FILTER (WHERE is_accepted)::int AS accepted,
    (SELECT count(*)::int FROM domain_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.domain_id=${scope.domainId} AND m.status='active' AND u.deleted_at IS NULL AND u.id<>'0') AS users
    FROM visible_sources`,
  );
  return unwrapRows<
    { problems: number; submissions: number; accepted: number; users: number }
  >(result as never)[0];
}
