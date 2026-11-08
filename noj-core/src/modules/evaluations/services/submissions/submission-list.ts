/**
 * 提交列表查询（listSubmissions）。
 */

import { normalizeResultStatus } from "./submission-result-format.ts";
import { projectContestSubmissionReads } from "./contest-read-projection.ts";
import { and, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import {
  evaluationAttempts,
  problems,
  problemVersions,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { getPendingQueueSnapshot } from "../queue.ts";
import { SubmissionStatus } from "../../types/index.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import {
  ListSubmissionsParams,
  ListSubmissionsResult,
  SubmissionListItem,
} from "./submissions-types.ts";

/**
 * 查询提交列表（分页 + 筛选）。
 *
 * 使用 LEFT JOIN 一次获取提交、题目、评测结果，避免 N+1。
 * 不返回 code 字段（源代码仅在详情接口返回）。
 */
export async function listSubmissions(
  params: ListSubmissionsParams,
): Promise<ListSubmissionsResult> {
  const db = getDb();
  const {
    userId,
    contestId,
    problemId,
    problemSearch,
    submissionId,
    userSearch,
    language,
    status,
    from,
    to,
    excludeContest,
    versionId,
    versionOrigin,
    validOnly,
    acceptedOnly,
    upgradable,
    page,
    perPage,
  } = params;

  // 动态构建筛选条件（仅对提供的参数添加条件）
  const conditions: ReturnType<typeof eq>[] = [
    params.domainId
      ? eq(submissions.domain_id, params.domainId)
      : sql`(${submissions.domain_id} = ${DEFAULT_DOMAIN_ID} OR ${submissions.domain_id} IS NULL)`,
  ];
  if (
    params.platformAdmin !== "forensics" &&
    (status || validOnly || acceptedOnly)
  ) {
    // 结果筛选本身也会泄露 OI 判定，赛期不让隐藏结果参与筛选计数。
    conditions.push(
      sql`NOT EXISTS (SELECT 1 FROM contests c WHERE c.id = ${submissions.contest_id}
      AND c.type = 'oi' AND c.start_time <= ${new Date().toISOString()}
      AND c.end_time > ${new Date().toISOString()})`,
    );
  }

  if (userId) conditions.push(eq(submissions.user_id, userId));
  if (contestId) conditions.push(eq(submissions.contest_id, contestId));
  if (excludeContest) {
    conditions.push(
      isNull(submissions.contest_id) as unknown as ReturnType<typeof eq>,
    );
  }
  if (problemId) conditions.push(eq(submissions.problem_id, problemId));
  if (language) conditions.push(eq(submissions.language, language));
  if (status) {
    conditions.push(eq(submissions.status, status as SubmissionStatus));
  }
  if (from) conditions.push(gte(submissions.created_at, from));
  if (to) conditions.push(lte(submissions.created_at, to));
  if (versionId) {
    conditions.push(eq(submissions.submitted_version_id, versionId));
  }
  if (versionOrigin) {
    conditions.push(eq(submissions.version_origin, versionOrigin));
  }
  if (validOnly) conditions.push(eq(submissions.is_valid, true));
  if (acceptedOnly) conditions.push(eq(submissions.is_accepted, true));
  if (upgradable) {
    // 作答升级跟随使用域绑定；exact(X) 的当前作答版本不随源域发布新版变化。
    const answerVersion =
      sql`CASE WHEN ${problems.effective_version_mode}='exact'
      THEN ${problems.required_version_id} ELSE ${problems.latest_version_id} END`;
    conditions.push(
      sql`${answerVersion} IS NOT NULL
        AND ${submissions.submitted_version_id} IS DISTINCT FROM ${answerVersion}` as unknown as ReturnType<
        typeof eq
      >,
    );
  }

  // problemSearch: problem_id 精确匹配 OR problems.title ILIKE 模糊搜索
  if (problemSearch) {
    conditions.push(
      or(
        eq(submissions.problem_id, problemSearch),
        ilike(problems.title, `%${problemSearch}%`),
      ) as unknown as ReturnType<typeof eq>,
    );
  }

  // submissionId: submissions.id ILIKE 前缀匹配
  if (submissionId) {
    conditions.push(
      ilike(submissions.id, `${submissionId}%`) as unknown as ReturnType<
        typeof eq
      >,
    );
  }

  // userSearch: users.username ILIKE OR submissions.user_id 前缀匹配
  if (userSearch) {
    conditions.push(
      or(
        ilike(users.username, `%${userSearch}%`),
        ilike(submissions.user_id, `${userSearch}%`),
      ) as unknown as ReturnType<typeof eq>,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // COUNT 总数（需 LEFT JOIN problems 以支持 problemSearch，users 以支持 userSearch）
  let countQuery = db
    .select({ total: sql<number>`count(*)::int` })
    .from(submissions)
    .leftJoin(problems, eq(submissions.problem_id, problems.id));
  // userSearch 需要关联 users 表
  if (userSearch) {
    countQuery = countQuery.leftJoin(users, eq(submissions.user_id, users.id));
  }
  const [countRow] = await countQuery.where(where);

  const total = Number(countRow?.total ?? 0);

  // 无数据时提前返回，避免无效查询
  if (total === 0) {
    return { data: [], total: 0 };
  }

  const offset = (page - 1) * perPage;

  // 数据查询：LEFT JOIN problems + evaluation_results（+ users 当需要 userSearch 时）
  let dataQuery = db
    .select({
      id: submissions.id,
      public_id: submissions.public_id,
      user_id: submissions.user_id,
      problem_id: submissions.problem_id,
      contest_id: submissions.contest_id,
      language: submissions.language,
      file_name: submissions.file_name,
      status: submissions.status,
      created_at: submissions.created_at,
      judge_started_at: submissions.judge_started_at,
      judge_finished_at: submissions.judge_finished_at,
      submitted_version_id: submissions.submitted_version_id,
      version_origin: submissions.version_origin,
      problem_title: problems.title,
      submitted_version: problemVersions.version,
      // 最近一次运行的判定：优先最近终态尝试，存量行回退有效成绩指针
      result_status: evaluationAttempts.result_status ??
        evaluationAttempts.state,
      result_score: evaluationAttempts.score,
      result_time_ms: evaluationAttempts.time_ms,
      result_memory_kb: evaluationAttempts.memory_kb,
    })
    .from(submissions)
    .leftJoin(problems, eq(submissions.problem_id, problems.id))
    // 提交时版本号（展示用）：unknown 历史提交 submitted_version_id 为 null → 版本号也 null
    .leftJoin(
      problemVersions,
      eq(problemVersions.id, submissions.submitted_version_id),
    )
    .leftJoin(
      evaluationAttempts,
      eq(
        evaluationAttempts.id,
        sql`coalesce(${submissions.latest_attempt_id}, ${submissions.effective_attempt_id})`,
      ),
    );
  if (userSearch) {
    dataQuery = dataQuery.leftJoin(
      users,
      eq(submissions.user_id, users.id),
    );
  }
  const rows = await dataQuery.where(where)
    .orderBy(sql`${submissions.created_at} DESC`)
    .offset(offset)
    .limit(perPage);

  // 仅当存在无结果的 in-progress 提交时才查 Redis 队列
  // （避免每次列表请求都 LRANGE 整个队列）
  const hasInProgress = rows.some((r) => !r.result_status);
  let pendingPosMap: Map<string, number> | null = null;
  let queueLength: number | null = null;
  if (hasInProgress && params.platformAdmin === "live_status") {
    try {
      const snapshot = await getPendingQueueSnapshot();
      const pendingIds = snapshot.ids;
      queueLength = snapshot.length;
      // LRANGE 返回最新优先（LPUSH），pendingIds.length - idx
      // 使队列位置从 1（下个出队）递增；积压时 snapshot 已回退全量
      pendingPosMap = new Map(
        pendingIds.map((id, idx) => [id, pendingIds.length - idx]),
      );
    } catch {
      // Redis 不可用时，pendingPosMap 保持 null，所有未完成提交视为"评测中"
    }
  }

  const data: SubmissionListItem[] = rows.map((row) => {
    const hasResult = !!row.result_status;
    const queue_position = !hasResult && pendingPosMap
      ? (pendingPosMap.get(row.id) ?? null)
      : null;
    return {
      id: row.id,
      public_id: row.public_id,
      user_id: row.user_id,
      problem_id: row.problem_id,
      contest_id: row.contest_id,
      language: row.language,
      file_name: row.file_name,
      status: row.status,
      created_at: row.created_at,
      judge_started_at: row.judge_started_at ?? null,
      judge_finished_at: row.judge_finished_at ?? null,
      queue_position,
      queue_length: !hasResult ? queueLength : null,
      problem: {
        id: row.problem_id,
        title: row.problem_title ?? "",
      },
      submitted_version_id: row.submitted_version_id ?? null,
      version_origin: row.version_origin ?? "legacy_unknown",
      submitted_version: row.submitted_version ?? null,
      result: row.result_status
        ? {
          status: normalizeResultStatus(row.result_status) ?? "finished",
          score: row.result_score ?? 0,
          time_ms: row.result_time_ms,
          memory_kb: row.result_memory_kb,
        }
        : null,
    };
  });

  return {
    data: await projectContestSubmissionReads(
      data,
      userId ?? null,
      params.platformAdmin === "live_status",
    ),
    total,
  };
}
