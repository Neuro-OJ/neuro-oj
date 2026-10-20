import { sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import { assertActiveInstanceAccount } from "../../../domains/identity/index.ts";
import {
  DEFAULT_DOMAIN_ID,
  loadWorkspace,
} from "../../../domains/workspace/index.ts";
import { domainProblemBindingAvailableWhere } from "../../problems/index.ts";
import { contestResultVisibility } from "./submissions/submission-projection.ts";
import { oiVerdict } from "./submissions/oi-details.ts";
import type { ContestType } from "../../contests/index.ts";
import type { ProblemReference } from "../../../shared/workspace/types.ts";
import { currentTeacherSubmissionAccessWhere } from "../../../domains/education/index.ts";

export type OwnSubmissionKind = "submission" | "objective";
/** 由已授权服务器入口指定；查询条件在计数和分页之前执行。 */
export interface OwnSubmissionHistoryScope {
  domainId?: string;
  kind?: OwnSubmissionKind;
  problemId?: string;
}
const ownedSources = sql`(
 SELECT 'submission'::text AS kind,id,public_id,user_id,problem_id,domain_id,domain_problem_binding_id,
 contest_id,assignment_id,assignment_item_id,language,code,NULL::jsonb AS answers,file_name,status,created_at,submitted_version_id,
 is_valid,is_accepted,latest_attempt_id,effective_attempt_id,artifact_storage_url IS NOT NULL AS has_artifact FROM submissions
 UNION ALL
 SELECT 'objective'::text AS kind,id,id AS public_id,user_id,paper_id AS problem_id,domain_id,domain_problem_binding_id,
 contest_id,assignment_id,assignment_item_id,'objective' AS language,NULL AS code,answers,NULL AS file_name,status,created_at,submitted_version_id,
 is_valid,is_accepted,latest_attempt_id,effective_attempt_id,false AS has_artifact FROM objective_submissions
) owned`;
interface HistoryRow {
  kind: OwnSubmissionKind;
  id: string;
  public_id: string;
  problem_id: string;
  user_id: string;
  username: string;
  submission_mode: string;
  submitted_version: number | null;
  domain_id: string;
  domain_slug: string;
  domain_name: string;
  domain_accessible: boolean;
  domain_problem_binding_id: string | null;
  resource_available: boolean;
  source_domain_id: string;
  source_domain_slug: string;
  number: number;
  problem_title: string;
  contest_id: string | null;
  assignment_id: string | null;
  assignment_item_id: string | null;
  contest_type: ContestType | null;
  contest_created_by: string | null;
  contest_start: string | null;
  contest_end: string | null;
  language: string;
  code: string | null;
  answers: Record<string, unknown> | null;
  file_name: string | null;
  has_artifact: boolean;
  status: string;
  submitted_version_id: string | null;
  is_valid: boolean;
  is_accepted: boolean;
  created_at: string;
  result_status: string | null;
  score: number | null;
  verdict: string | null;
  time_ms: number | null;
  memory_kb: number | null;
}
export interface OwnSubmissionHistoryItem {
  kind: OwnSubmissionKind;
  id: string;
  public_id: string;
  problem_id: string;
  queue_position: null;
  queue_length: null;
  user_id: string;
  username: string;
  domain_id: string;
  domain_problem_binding_id: string | null;
  submission_mode: string;
  submitted_version: number | null;
  domain: { id: string; slug: string; name: string; accessible: boolean };
  problem: { id: string; title: string };
  reference: ProblemReference;
  resource_available: boolean;
  contest_id: string | null;
  assignment_origin: {
    assignment_id: string;
    assignment_item_id: string;
  } | null;
  language: string;
  file_name: string | null;
  has_artifact: boolean;
  created_at: string;
  submitted_version_id: string | null;
  status: string;
  result_visibility: "hidden" | "summary" | "cases";
  is_valid?: boolean;
  is_accepted?: boolean;
  result?: {
    status: string | null;
    score: number | null;
    verdict: string | null;
    time_ms: number | null;
    memory_kb: number | null;
  } | null;
  code?: string | null;
  answers?: Record<string, unknown> | null;
}
function projectHistory(
  row: HistoryRow,
  original = false,
): OwnSubmissionHistoryItem {
  const running = row.contest_start !== null && row.contest_end !== null &&
    Date.parse(row.contest_start) <= Date.now() &&
    Date.now() < Date.parse(row.contest_end);
  const visibility = row.contest_type
    ? contestResultVisibility(row.contest_type, running)
    : "cases";
  const qualified = `${row.source_domain_slug}:${row.number}`,
    isShared = row.source_domain_id !== row.domain_id;
  const item: OwnSubmissionHistoryItem = {
    kind: row.kind,
    id: row.id,
    public_id: row.public_id,
    problem_id: row.problem_id,
    queue_position: null,
    queue_length: null,
    user_id: row.user_id,
    username: row.username,
    domain_id: row.domain_id,
    domain_problem_binding_id: row.domain_problem_binding_id,
    submission_mode: row.submission_mode,
    submitted_version: row.submitted_version,
    domain: {
      id: row.domain_id,
      slug: row.domain_slug,
      name: row.domain_name,
      accessible: row.domain_accessible,
    },
    problem: {
      id: row.problem_id,
      title: row.resource_available ? row.problem_title : "资源不可用",
    },
    reference: {
      problem_id: row.problem_id,
      source_domain_id: row.source_domain_id,
      source_domain_slug: row.source_domain_slug,
      number: row.number,
      qualified_ref: qualified,
      display_ref: isShared ? qualified : String(row.number),
      is_shared: isShared,
    },
    resource_available: row.resource_available,
    contest_id: row.contest_id,
    assignment_origin: row.assignment_id
      ? {
        assignment_id: row.assignment_id,
        assignment_item_id: row.assignment_item_id!,
      }
      : null,
    language: row.language,
    file_name: row.file_name,
    has_artifact: row.has_artifact,
    created_at: row.created_at,
    submitted_version_id: row.submitted_version_id,
    status: visibility === "hidden" ? "submitted" : row.status,
    result_visibility: visibility,
  };
  if (visibility !== "hidden") {
    item.is_valid = row.is_valid;
    item.is_accepted = row.is_accepted;
    item.result = row.result_status === null ? null : {
      status: row.result_status,
      score: row.score,
      verdict: oiVerdict({ oi: { verdict: row.verdict } }) ?? null,
      time_ms: row.time_ms,
      memory_kb: row.memory_kb,
    };
  }
  if (original) {
    if (row.kind === "submission") item.code = row.code;
    else item.answers = row.answers;
  }
  return item;
}
async function readHistory(
  actorId: string,
  options: {
    page: number;
    perPage: number;
    kind?: OwnSubmissionKind;
    id?: string;
    domainId?: string;
    problemId?: string;
    contestId?: string;
    username?: string;
    visibleOnly?: boolean;
    platformAdmin?: boolean;
    submissionMode?: string;
    upgradable?: boolean;
  },
) {
  await assertActiveInstanceAccount(actorId);
  const domainId = sql`coalesce(owned.domain_id,${DEFAULT_DOMAIN_ID})`;
  const entered = sql`(history_domain.status<>'suspended' AND
  (history_domain.configuration->>'access'='public' OR EXISTS(SELECT 1 FROM domain_memberships member
   WHERE member.domain_id=${domainId} AND member.user_id=${actorId} AND member.status='active')))`;
  const accessible = sql`(${!!options
    .platformAdmin} OR ${entered} OR (owned.domain_id IS NULL AND history_domain.id IS NULL))`;
  const available = sql`(${accessible} AND (
  (owned.domain_id IS NULL AND owned.domain_problem_binding_id IS NULL AND source_problem.visibility='public')
  OR (EXISTS(SELECT 1 FROM domain_problem_bindings target_binding
    WHERE target_binding.id=owned.domain_problem_binding_id
    AND (${!!options
    .platformAdmin} OR target_binding.visibility='public' OR EXISTS(SELECT 1 FROM domain_memberships member
     WHERE member.domain_id=${domainId} AND member.user_id=${actorId} AND member.status='active')))
   AND ${
    domainProblemBindingAvailableWhere(
      sql`owned.domain_problem_binding_id`,
      domainId,
      { member: true },
    )
  })))`;
  const submissionMode =
    sql`CASE WHEN owned.kind='objective' THEN 'objective' WHEN source_problem.submission_mode='code' AND source_problem.llm_config IS NOT NULL THEN 'llm' ELSE source_problem.submission_mode END`;
  const visible = sql`(owned.user_id=${actorId} OR (${available} AND
    (owned.contest_id IS NULL OR ${!!options.platformAdmin} OR EXISTS (
      SELECT 1 FROM contests permitted_contest WHERE permitted_contest.id=owned.contest_id AND
      (permitted_contest.is_public=true OR permitted_contest.created_by=${actorId}
        OR EXISTS (SELECT 1 FROM contest_participants cp WHERE cp.contest_id=permitted_contest.id AND cp.user_id=${actorId}))))))`;
  const where = sql`${
    options.visibleOnly ? visible : sql`owned.user_id=${actorId}`
  }
  ${
    options.visibleOnly && options.username
      ? sql`AND submitter.username=${options.username}`
      : sql``
  }
  ${options.domainId ? sql`AND ${domainId}=${options.domainId}` : sql``}
  ${options.problemId ? sql`AND owned.problem_id=${options.problemId}` : sql``}
  ${options.kind ? sql`AND owned.kind=${options.kind}` : sql``}
  ${options.contestId ? sql`AND owned.contest_id=${options.contestId}` : sql``}
  ${
    options.submissionMode
      ? sql`AND ${submissionMode}=${options.submissionMode}`
      : sql``
  }
  ${
    options.upgradable
      ? sql`AND EXISTS (SELECT 1 FROM domain_problem_bindings upgrade_binding
    WHERE upgrade_binding.id=owned.domain_problem_binding_id AND
    owned.submitted_version_id IS DISTINCT FROM CASE WHEN upgrade_binding.effective_version_mode='exact'
      THEN upgrade_binding.required_version_id ELSE source_problem.latest_version_id END)`
      : sql``
  }
  ${options.id ? sql`AND owned.id=${options.id}` : sql``}`;
  const joins = sql`FROM ${ownedSources}
  LEFT JOIN domains history_domain ON history_domain.id=${domainId}
  JOIN problems source_problem ON source_problem.id=owned.problem_id
  JOIN users submitter ON submitter.id=owned.user_id`;
  const db = getDb();
  const [count] = unwrapRows<{ count: number }>(
    await db.execute(
      sql`SELECT count(*)::int AS count ${joins} WHERE ${where}`,
    ) as never,
  );
  const rows = unwrapRows<HistoryRow>(
    await db.execute(
      sql`SELECT owned.kind,owned.id,owned.public_id,owned.user_id,owned.problem_id,
  owned.domain_problem_binding_id,owned.contest_id,owned.assignment_id,owned.assignment_item_id,owned.language,owned.file_name,owned.status,owned.created_at,
  owned.submitted_version_id,owned.is_valid,owned.is_accepted,owned.has_artifact,
  CASE WHEN submitter.deleted_at IS NULL THEN submitter.username ELSE '已注销用户' END AS username,
  ${submissionMode} AS submission_mode, version.version AS submitted_version,
  ${
        options.id
          ? sql`owned.code,owned.answers`
          : sql`NULL::text AS code,NULL::jsonb AS answers`
      },
  ${domainId} AS domain_id,coalesce(history_domain.slug,'main') AS domain_slug,coalesce(history_domain.name,'默认域') AS domain_name,
  ${accessible} AS domain_accessible,${available} AS resource_available,
  coalesce(source_problem.domain_id,${DEFAULT_DOMAIN_ID}) AS source_domain_id,coalesce(source_domain.slug,'main') AS source_domain_slug,
  source_problem.number,source_problem.title AS problem_title,
  contest.type AS contest_type,contest.created_by AS contest_created_by,contest.start_time AS contest_start,contest.end_time AS contest_end,
  attempt.result_status,attempt.score,attempt.details->'oi'->>'verdict' AS verdict,attempt.time_ms,attempt.memory_kb
  ${joins}
  LEFT JOIN domains source_domain ON source_domain.id=source_problem.domain_id
  LEFT JOIN problem_versions version ON version.id=owned.submitted_version_id
  LEFT JOIN contests contest ON contest.id=owned.contest_id
  LEFT JOIN evaluation_attempts attempt ON attempt.id=${
        options.visibleOnly
          ? sql`CASE WHEN owned.kind='objective' THEN coalesce(owned.effective_attempt_id,owned.latest_attempt_id) ELSE coalesce(owned.latest_attempt_id,owned.effective_attempt_id) END`
          : sql`coalesce(owned.effective_attempt_id,owned.latest_attempt_id)`
      }
  WHERE ${where} ORDER BY owned.created_at DESC,owned.kind,owned.id DESC
  LIMIT ${options.perPage} OFFSET ${(options.page - 1) * options.perPage}`,
    ) as never,
  );
  return { rows, total: count.count };
}

/** 显式域统一列表；实际查看者与用户名筛选分开，权限同时作用于总数和分页。 */
export async function listVisibleDomainSubmissionHistory(
  slug: string,
  actorId: string,
  options: {
    page: number;
    perPage: number;
    username?: string;
    kind?: string;
    problemId?: string;
    contestId?: string;
    id?: string;
    upgradable?: boolean;
  },
) {
  const access = await loadWorkspace(slug, actorId);
  const mode = options.kind === "all" || !options.kind
    ? undefined
    : options.kind;
  if (
    mode &&
    !["submission", "objective", "code", "llm", "artifact", "prediction", "ui"]
      .includes(mode)
  ) throw new BadRequestError("提交题型无效");
  const actorName = unwrapRows<{ username: string }>(
    await getDb().execute(
      sql`SELECT username FROM users WHERE id=${actorId}`,
    ) as never,
  )[0].username;
  const { rows, total } = await readHistory(actorId, {
    ...options,
    domainId: access.domain.id,
    visibleOnly: true,
    username: options.username === undefined
      ? actorName
      : options.username.trim(),
    kind: mode === "objective" || mode === "submission" ? mode : undefined,
    submissionMode: mode === "objective" || mode === "submission"
      ? undefined
      : mode,
    platformAdmin: access.platformAdmin,
  });
  const data = rows.map((row) => {
    const organizer = access.platformAdmin ||
      access.context.domainPermissions.has("contest:manage") ||
      row.contest_id && row.contest_created_by === actorId &&
        access.context.domainPermissions.has("contest:manage_own");
    const projected = projectHistory(
      organizer ? { ...row, contest_start: null, contest_end: null } : row,
    );
    if (row.user_id !== actorId) projected.assignment_origin = null;
    if (
      !organizer && row.user_id !== actorId && row.contest_type &&
      row.contest_end && Date.parse(row.contest_end) > Date.now()
    ) {
      projected.result_visibility = "hidden";
      projected.status = "submitted";
      delete projected.result;
      delete projected.is_valid;
      delete projected.is_accepted;
    }
    return projected;
  });
  return { data, total };
}
/** 统一账号本人目录；失去工作空间访问权仍保留原提交身份与成绩摘要，不恢复题目内容。 */
export async function listOwnSubmissionHistory(
  actorId: string,
  page: number,
  perPage: number,
  scope: OwnSubmissionHistoryScope = {},
) {
  const { rows, total } = await readHistory(actorId, {
    page,
    perPage,
    ...scope,
  });
  return { data: rows.map((row) => projectHistory(row)), total };
}
/** 仅本人原始代码或答案；不存在代理其他账号读取的参数。 */
export async function getOwnSubmissionHistory(
  actorId: string,
  kind: OwnSubmissionKind,
  id: string,
) {
  const { rows } = await readHistory(actorId, {
    page: 1,
    perPage: 1,
    kind,
    id,
  });
  if (!rows.length) throw new NotFoundError("提交不存在");
  return projectHistory(rows[0], true);
}

/** 域客观题详情：普通成员只读摘要，原答案须本人或获授权批阅者读取。 */
export async function getDomainObjectiveSubmissionHistory(
  slug: string,
  actorId: string,
  id: string,
) {
  const access = await loadWorkspace(slug, actorId);
  const { rows } = await readHistory(actorId, {
    page: 1,
    perPage: 1,
    kind: "objective",
    id,
    visibleOnly: true,
    domainId: access.domain.id,
    platformAdmin: access.platformAdmin,
  });
  const row = rows[0];
  if (!row) throw new NotFoundError("提交不存在");
  const organizer = access.platformAdmin ||
    access.context.domainPermissions.has("contest:manage") ||
    row.contest_created_by === actorId &&
      access.context.domainPermissions.has("contest:manage_own");
  const running = row.contest_end !== null &&
    Date.parse(row.contest_end) > Date.now();
  const teacher = row.user_id !== actorId &&
    unwrapRows<{ allowed: boolean }>(
      await getDb().execute(
        sql`SELECT ${
          currentTeacherSubmissionAccessWhere(
            row.user_id,
            access.domain.id,
            actorId,
          )
        } AS allowed`,
      ) as never,
    )[0]?.allowed;
  const canRead = row.user_id === actorId || organizer || !running &&
      (access.context.domainPermissions.has("submission:read_all") ||
        teacher === true);
  const item = projectHistory(
    organizer ? { ...row, contest_start: null, contest_end: null } : row,
    canRead,
  );
  if (row.user_id !== actorId) item.assignment_origin = null;
  if (
    !organizer && row.user_id !== actorId && row.contest_type &&
    running
  ) {
    item.result_visibility = "hidden";
    item.status = "submitted";
    delete item.result;
    delete item.is_valid;
    delete item.is_accepted;
  }
  return { ...item, can_view_answers: canRead, can_view_source: false };
}
