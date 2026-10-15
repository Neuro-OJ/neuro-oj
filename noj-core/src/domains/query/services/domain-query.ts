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
  /** 题库状态纳入本域已结束比赛；全站排行开关不改变本人通过记录。 */
  includeAllEndedContests?: boolean;
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
    scope.domainId !== DEFAULT_DOMAIN_ID || !!scope.includeAllEndedContests
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

/** 首页最新评测只返回可展示的基本字段；登录者看本人，游客看当前域公开练习。 */
export async function getDomainRecentSubmissions(
  scope: DomainQueryScope,
  actorId: string | null,
) {
  const rows = await getDb().execute(sql`
    SELECT s.id, s.public_id, s.problem_id, s.status, s.created_at,
      json_build_object('title',p.title) AS problem,
      CASE WHEN a.result_kind='judged' THEN json_build_object(
        'status',a.result_status,'score',a.score,'time_ms',a.time_ms,'memory_kb',a.memory_kb
      ) ELSE NULL END AS result
    FROM submissions s JOIN problems p ON p.id=s.problem_id
    LEFT JOIN evaluation_attempts a ON a.id=coalesce(s.effective_attempt_id,s.latest_attempt_id)
    WHERE s.contest_id IS NULL AND ${
    submissionQueryVisibility(scope, {
      domainId: sql`s.domain_id`,
      bindingId: sql`s.domain_problem_binding_id`,
      contestId: sql`s.contest_id`,
    })
  }
      ${actorId ? sql`AND s.user_id=${actorId}` : sql``}
    ORDER BY s.created_at DESC,s.id DESC LIMIT 5
  `);
  return unwrapRows<{
    id: string;
    public_id: string | null;
    problem_id: string;
    status: string;
    created_at: string;
    problem: { title: string };
    result: {
      status: string;
      score: number;
      time_ms: number | null;
      memory_kb: number | null;
    } | null;
  }>(rows as never);
}

/** 题库本人状态过滤在分页前执行，赛中隐藏及其他域记录不能影响命中数。 */
export function domainProblemProgressWhere(
  scope: DomainQueryScope,
  problemId: AnyColumn | SQL,
  actorId: string,
  state: "solved" | "attempted" | "unseen",
) {
  scope = { ...scope, includeAllEndedContests: true };
  const source =
    sql`SELECT s.* FROM (SELECT * FROM ${unifiedSubmissionSources}) s
    WHERE s.problem_id=${problemId} AND s.user_id=${actorId} AND ${
      submissionQueryVisibility(scope, {
        domainId: sql`s.domain_id`,
        bindingId: sql`s.domain_problem_binding_id`,
        contestId: sql`s.contest_id`,
      })
    }`;
  const attempted = sql`EXISTS (${source})`;
  const solved = sql`EXISTS (${source} AND s.is_valid AND s.is_accepted)`;
  return state === "solved"
    ? solved
    : state === "unseen"
    ? sql`NOT ${attempted}`
    : sql`${attempted} AND NOT ${solved}`;
}

/** 一页题目的域内统计与本人状态一起聚合，不按单元格逐项查询。 */
export async function getDomainProblemSummaries(
  scope: DomainQueryScope,
  problemIds: string[],
  actorId: string | null,
) {
  if (!problemIds.length) return [];
  scope = { ...scope, includeAllEndedContests: true };
  const result = await getDb().execute(
    sql`WITH visible_sources AS (${visibleSources(scope)})
    SELECT problem_id, count(*)::int AS submit_count,
      count(*) FILTER (WHERE is_valid)::int AS valid_submissions,
      count(*) FILTER (WHERE is_valid AND is_accepted)::int AS accepted_submissions,
      bool_or(user_id=${actorId}) AS attempted,
      bool_or(user_id=${actorId} AND is_valid AND is_accepted) AS solved
    FROM visible_sources WHERE problem_id IN (${
      sql.join(problemIds.map((id) => sql`${id}`), sql`,`)
    })
    GROUP BY problem_id`,
  );
  return unwrapRows<
    {
      problem_id: string;
      submit_count: number;
      valid_submissions: number;
      accepted_submissions: number;
      attempted: boolean;
      solved: boolean;
    }
  >(result as never);
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
