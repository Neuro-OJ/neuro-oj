/**
 * 提交可见性读取政策。
 *
 * 这是共享 schema 上的纯 SQL 政策：它只读取域、题库绑定和竞赛窗口事实，
 * 不调用 query/search/submission 业务服务，也不依赖 problems/contests 门面。
 * 题目与题单的 read path 可以复用它，避免业务模块反向依赖聚合 read-model。
 */
import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import { getDb } from "../../shared/db/connection.ts";
import { unwrapRows } from "../../shared/base/sql-rows.ts";
import { DEFAULT_DOMAIN_ID } from "./types.ts";
import { unifiedSubmissionSources } from "../../shared/versioning/submission-sources.ts";

const CONTEST_TIME_ISO_REGEX_SQL =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";

/** 统计/本人状态查询的已解析域范围。 */
export interface SubmissionQueryScope {
  domainId: string;
  member: boolean;
  includeAllEndedContests?: boolean;
}

export interface ProblemSubmissionSummary {
  problem_id: string;
  submit_count: number;
  valid_submissions: number;
  accepted_submissions: number;
  attempted: boolean;
  solved: boolean;
}

function endedWindowCondition(endTimeExpr: AnyColumn | SQL): SQL {
  return sql`CASE
    WHEN ${endTimeExpr} ~ ${CONTEST_TIME_ISO_REGEX_SQL}
     AND pg_input_is_valid(${endTimeExpr}, 'timestamptz')
    THEN ${endTimeExpr}::timestamptz <= now()
    ELSE false
  END`;
}

function unendedPublicContestForProblem(
  problemIdExpr: AnyColumn | SQL,
  domainIdExpr?: AnyColumn | SQL,
): SQL {
  return sql`EXISTS (
    SELECT 1 FROM contest_problems cp
    JOIN contests c ON c.id = cp.contest_id
    WHERE cp.problem_id = ${problemIdExpr}
      ${
    domainIdExpr
      ? sql`AND COALESCE(c.domain_id, ${DEFAULT_DOMAIN_ID}) = ${domainIdExpr}`
      : sql``
  }
      AND c.kind = 'public'
      AND CASE
        WHEN c.end_time ~ ${CONTEST_TIME_ISO_REGEX_SQL}
         AND pg_input_is_valid(c.end_time, 'timestamptz')
        THEN c.end_time::timestamptz > now()
        ELSE true
      END
  )`;
}

function bindingAvailabilityCondition(): SQL {
  return sql`b.disabled_at IS NULL AND p.latest_version_id IS NOT NULL AND src.status <> 'suspended'
    AND EXISTS (SELECT 1 FROM problem_versions v WHERE v.problem_id = p.id
      AND v.id = CASE WHEN b.effective_version_mode = 'exact' THEN b.required_version_id ELSE p.latest_version_id END)
    AND (b.kind = 'owned' OR (src.configuration->>'access' = 'public' AND p.visibility = 'public'
      AND COALESCE(share.enabled, false) AND (share.scope = 'all' OR EXISTS (
        SELECT 1 FROM problem_share_targets t WHERE t.problem_id = p.id AND t.domain_id = b.domain_id))
      AND EXISTS (SELECT 1 FROM domain_problem_bindings owned WHERE owned.domain_id = src.id
        AND owned.problem_id = p.id AND owned.kind = 'owned' AND owned.visibility = 'public' AND owned.disabled_at IS NULL)
      AND NOT ${unendedPublicContestForProblem(sql`p.id`, sql`p.domain_id`)}))`;
}

function availableBindingWhere(
  selector: SQL,
  domainId: AnyColumn | SQL,
  member: boolean | SQL,
): SQL {
  return sql`EXISTS (SELECT 1 FROM domain_problem_bindings b
    JOIN problems p ON p.id = b.problem_id JOIN domains src ON src.id = p.domain_id
    LEFT JOIN problem_share_settings share ON share.problem_id = p.id
    WHERE ${selector} AND b.domain_id = ${domainId}
      AND (${member} OR b.visibility = 'public') AND ${bindingAvailabilityCondition()})`;
}

/** 所有提交聚合必须使用的域、绑定、保密和竞赛窗口过滤。 */
export function submissionQueryVisibility(
  scope: SubmissionQueryScope,
  columns: {
    domainId: AnyColumn | SQL;
    bindingId: AnyColumn | SQL;
    contestId: AnyColumn | SQL;
  },
): SQL {
  return sql`coalesce(${columns.domainId},${DEFAULT_DOMAIN_ID})=${scope.domainId}
    AND (${columns.domainId} IS NULL OR EXISTS (SELECT 1 FROM domains query_domain
      WHERE query_domain.id=${scope.domainId} AND query_domain.status<>'suspended'
        AND (query_domain.configuration->>'access'='public' OR ${scope.member})))
    AND ((${columns.domainId} IS NULL AND ${columns.bindingId} IS NULL AND ${
    scope.domainId === DEFAULT_DOMAIN_ID
  })
      OR ${
    availableBindingWhere(
      sql`b.id = ${columns.bindingId}`,
      sql`${scope.domainId}`,
      scope.member,
    )
  })
    AND (${columns.contestId} IS NULL OR EXISTS (SELECT 1 FROM contests visible_contest
      WHERE visible_contest.id=${columns.contestId}
      AND ${endedWindowCondition(sql`visible_contest.end_time`)}
      AND (${
    scope.domainId !== DEFAULT_DOMAIN_ID || !!scope.includeAllEndedContests
  } OR visible_contest.affect_global_ranking=true)))`;
}

/**
 * 读取题库所需的最小提交聚合；它只依赖共享投影和访问政策，不能回调
 * evaluations/query 的业务门面。页面 read-model 可在此基础上组合展示字段，
 * problems 业务也可以直接使用这个低层只读政策而不反向依赖 read-model。
 */
export async function getProblemSubmissionSummaries(
  scope: SubmissionQueryScope,
  problemIds: string[],
  actorId: string | null,
): Promise<ProblemSubmissionSummary[]> {
  if (!problemIds.length) return [];
  const visibleScope = { ...scope, includeAllEndedContests: true };
  const result = await getDb().execute(
    sql`WITH visible_sources AS (
      SELECT * FROM ${unifiedSubmissionSources} s
      WHERE ${
      submissionQueryVisibility(visibleScope, {
        domainId: sql`s.domain_id`,
        bindingId: sql`s.domain_problem_binding_id`,
        contestId: sql`s.contest_id`,
      })
    }
    )
    SELECT problem_id, count(*)::int AS submit_count,
      count(*) FILTER (WHERE is_valid)::int AS valid_submissions,
      count(*) FILTER (WHERE is_valid AND is_accepted)::int AS accepted_submissions,
      bool_or(user_id=${actorId}) AS attempted,
      bool_or(user_id=${actorId} AND is_valid AND is_accepted) AS solved
    FROM visible_sources WHERE problem_id IN (${
      sql.join(
        problemIds.map((id) => sql`${id}`),
        sql`,`,
      )
    })
    GROUP BY problem_id`,
  );
  return unwrapRows<ProblemSubmissionSummary>(result as never);
}

/** 题库分页中的本人状态过滤，直接返回 SQL 条件。 */
export function domainProblemProgressWhere(
  scope: SubmissionQueryScope,
  problemId: AnyColumn | SQL,
  actorId: string,
  state: "solved" | "attempted" | "unseen",
): SQL {
  const visibleScope = { ...scope, includeAllEndedContests: true };
  const source =
    sql`SELECT s.* FROM (SELECT * FROM ${unifiedSubmissionSources}) s
    WHERE s.problem_id=${problemId} AND s.user_id=${actorId} AND ${
      submissionQueryVisibility(
        visibleScope,
        {
          domainId: sql`s.domain_id`,
          bindingId: sql`s.domain_problem_binding_id`,
          contestId: sql`s.contest_id`,
        },
      )
    }`;
  const attempted = sql`EXISTS (${source})`;
  const solved = sql`EXISTS (${source} AND s.is_valid AND s.is_accepted)`;
  return state === "solved"
    ? solved
    : state === "unseen"
    ? sql`NOT ${attempted}`
    : sql`${attempted} AND NOT ${solved}`;
}
