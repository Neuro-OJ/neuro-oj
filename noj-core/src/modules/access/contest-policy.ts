/**
 * access 提供的比赛保密与准入只读政策。
 *
 * 这里只读取共享 schema 中的 contest facts，不导入 problems 或 contests
 * business/service。这样题目业务和比赛业务都可以读取同一套政策而不形成运行时环；
 * 写入仍必须通过各自 application 用例。
 */
import {
  and,
  type AnyColumn,
  asc,
  eq,
  inArray,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { getDb } from "../../shared/db/connection.ts";
import type { DbRoot, DbTx } from "../../shared/db/executor.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  domains,
} from "../../shared/db/schema.ts";
import { resolvePublicId } from "../../shared/security/public-id.ts";
import { DEFAULT_DOMAIN_ID } from "./types.ts";
import { type AccessActor, loadWorkspace, loadWorkspaceTx } from "./policy.ts";

/** 访问政策只需要稳定的比赛类型标签，不依赖 contests 类型模块。 */
export type ContestType = "kaggle" | "oi" | "ioi" | "ioi_strict" | "acm";

const CONTEST_TIME_ISO_REGEX_SQL =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";

/** 只读合同内的安全赛期谓词，避免 problems 反向导入 contests service。 */
export function runningWindowCondition(
  startTimeExpr: AnyColumn | SQL,
  endTimeExpr: AnyColumn | SQL,
): SQL {
  return sql`CASE
    WHEN ${startTimeExpr} ~ ${CONTEST_TIME_ISO_REGEX_SQL}
     AND ${endTimeExpr} ~ ${CONTEST_TIME_ISO_REGEX_SQL}
     AND pg_input_is_valid(${startTimeExpr}, 'timestamptz')
     AND pg_input_is_valid(${endTimeExpr}, 'timestamptz')
    THEN ${startTimeExpr}::timestamptz <= now()
     AND ${endTimeExpr}::timestamptz > now()
    ELSE true
  END`;
}

function unendedWindowCondition(endTimeExpr: AnyColumn | SQL): SQL {
  return sql`CASE
    WHEN ${endTimeExpr} ~ ${CONTEST_TIME_ISO_REGEX_SQL}
     AND pg_input_is_valid(${endTimeExpr}, 'timestamptz')
    THEN ${endTimeExpr}::timestamptz > now()
    ELSE true
  END`;
}

/** 只读查询需要的最小根连接能力；不暴露 Executor 联合类型。 */
type ReadExecutor = Pick<DbRoot, "select">;

/** 公开赛保密快照；字段是不可变 DTO，不泄漏 contests 表行。 */
export type PublicContestSecrecyRef = Readonly<{
  contestId: string;
  publicId: string;
  title: string;
}>;

/** 批量读取本域保护信息；元数据列表保持可见，内容入口单独授权。 */
export async function loadDomainProblemProtection(
  domainId: string,
  problemIds: string[],
  executor: ReadExecutor = getDb(),
): Promise<Map<string, PublicContestSecrecyRef[]>> {
  const result = new Map<string, PublicContestSecrecyRef[]>();
  if (!problemIds.length) return result;
  const rows = await executor.select({
    problemId: contestProblems.problem_id,
    contestId: contests.id,
    publicId: contests.public_id,
    title: contests.title,
  }).from(contestProblems).innerJoin(
    contests,
    eq(contests.id, contestProblems.contest_id),
  )
    .where(and(
      eq(contests.domain_id, domainId),
      inArray(contestProblems.problem_id, problemIds),
      eq(contests.secrecy_enabled, true),
      unendedWindowCondition(contests.end_time),
    )).orderBy(asc(contests.end_time), asc(contests.id));
  for (const { problemId, ...ref } of rows) {
    const refs = result.get(problemId) ?? [];
    refs.push(ref);
    result.set(problemId, refs);
  }
  return result;
}

/** 题目在竞赛上下文中的准入与固定版本快照。 */
export type ContestAccessInfo = Readonly<{
  contestId: string;
  allowed: boolean;
  running: boolean;
  type?: ContestType;
  organizer?: boolean;
  pinnedVersionId?: string | null;
}>;

/** 竞赛保密政策快照，供跨模块访问判断使用。 */
export type ContestSecrecyPolicy = Readonly<{
  contestIds: readonly string[];
  refs: readonly PublicContestSecrecyRef[];
}>;

/** 竞赛固定版本/有效策略的最小只读快照。 */
export type ContestPolicySnapshot = Readonly<{
  contestId: string;
  problemId: string;
  pinnedVersionId: string | null;
  effectiveVersionMode: "any" | "exact";
  requiredVersionId: string | null;
  policyRevision: number;
  submissionLimit: number | null;
  running: boolean;
  secrecy: boolean;
}>;

/** 题目当前是否被进行中竞赛收编。 */
export async function isProblemInRunningContest(
  problemId: string,
  domainId?: string,
  executor: ReadExecutor = getDb(),
): Promise<boolean> {
  const rows = await executor.select({ id: contestProblems.contest_id })
    .from(contestProblems)
    .innerJoin(contests, eq(contestProblems.contest_id, contests.id))
    .where(and(
      eq(contestProblems.problem_id, problemId),
      domainId
        ? or(
          eq(contests.domain_id, domainId),
          domainId === DEFAULT_DOMAIN_ID
            ? isNull(contests.domain_id)
            : undefined,
        )
        : undefined,
      runningWindowCondition(contests.start_time, contests.end_time),
    ))
    .limit(1);
  return rows.length > 0;
}

/** 批量解析公开赛赛期题目；列表调用者可避免逐题查询。 */
export async function filterProblemsInRunningContest(
  problemIds: string[],
  domainId?: string,
): Promise<Set<string>> {
  if (problemIds.length === 0) return new Set();
  const rows = await getDb().selectDistinct({
    problem_id: contestProblems.problem_id,
  })
    .from(contestProblems)
    .innerJoin(contests, eq(contestProblems.contest_id, contests.id))
    .where(and(
      inArray(contestProblems.problem_id, problemIds),
      domainId ? eq(contests.domain_id, domainId) : undefined,
      runningWindowCondition(contests.start_time, contests.end_time),
    ));
  return new Set(rows.map((row) => row.problem_id));
}

/** 公开赛题目保密事实：end_time 之前（含赛前准备期）都属于保密窗口。 */
export async function loadPublicContestSecrecy(
  problemId: string,
  executor: ReadExecutor = getDb(),
  domainId?: string,
): Promise<PublicContestSecrecyRef[]> {
  const rows = await executor.select({
    contestId: contests.id,
    publicId: contests.public_id,
    title: contests.title,
  }).from(contestProblems)
    .innerJoin(contests, eq(contestProblems.contest_id, contests.id))
    .where(and(
      eq(contestProblems.problem_id, problemId),
      domainId
        ? or(
          eq(contests.domain_id, domainId),
          domainId === DEFAULT_DOMAIN_ID
            ? isNull(contests.domain_id)
            : undefined,
        )
        : undefined,
      eq(contests.secrecy_enabled, true),
      unendedWindowCondition(contests.end_time),
    ))
    .orderBy(asc(contests.end_time), asc(contests.id));
  return rows;
}

/** SQL 列级保密谓词，供 problems 列表/绑定查询复用。 */
export function unendedPublicContestForProblem(
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
      AND c.secrecy_enabled = true
      AND ${unendedWindowCondition(sql`c.end_time`)}
  )`;
}

/** 单条公开赛保密判断。 */
export async function isProblemInUnendedPublicContest(
  problemId: string,
  domainId?: string,
  executor: ReadExecutor = getDb(),
): Promise<boolean> {
  return (await loadPublicContestSecrecy(problemId, executor, domainId))
    .length > 0;
}

/** 解析 UUID 或公开竞赛编号；该解析不依赖 contests service 门面。 */
export function resolveContestId(value: string): Promise<string> {
  return resolvePublicId(
    contests,
    contests.id,
    contests.public_id,
    "ct",
    value,
    "竞赛不存在",
  );
}

function contestStatus(
  startTime: string,
  endTime: string,
): "pending" | "running" | "ended" {
  const now = Date.now();
  if (now < Date.parse(startTime)) return "pending";
  if (now < Date.parse(endTime)) return "running";
  return "ended";
}

/**
 * 只读竞赛准入快照：比赛、题目固定版本、域成员和窗口在同一读取口径内解析。
 * 写入流程不得把这个合同当作授权缓存跨请求复用。
 */
export async function verifyContestAccess(
  actor: AccessActor,
  contestId: string,
  problemId: string,
  options: { domainId?: string; executor?: DbTx } = {},
): Promise<ContestAccessInfo> {
  const db = options.executor ?? getDb();
  const [contest] = await db.select({
    id: contests.id,
    domainId: contests.domain_id,
    startTime: contests.start_time,
    endTime: contests.end_time,
    type: contests.type,
    createdBy: contests.created_by,
  }).from(contests).where(or(
    eq(contests.id, contestId),
    eq(contests.public_id, contestId),
  )).limit(1);
  if (!contest) return { contestId, allowed: false, running: false };
  const resolvedContestId = contest.id;
  const domainId = contest.domainId ?? DEFAULT_DOMAIN_ID;
  if (options.domainId && domainId !== options.domainId) {
    return { contestId: resolvedContestId, allowed: false, running: false };
  }
  const [domain] = await db.select({ slug: domains.slug }).from(domains)
    .where(eq(domains.id, domainId)).limit(1);
  if (!domain) {
    return { contestId: resolvedContestId, allowed: false, running: false };
  }
  // 受理事务内的授权不得另取根连接，否则池耗尽时持有连接再等连接。
  const workspace = options.executor
    ? await loadWorkspaceTx(options.executor, domain.slug, actor)
    : await loadWorkspace(domain.slug, actor);
  if (!workspace.membership && !workspace.platformAdmin) {
    return { contestId: resolvedContestId, allowed: false, running: false };
  }
  const organizer = workspace.platformAdmin ||
    workspace.context.domainPermissions.has("contest:manage") ||
    Boolean(
      actor.kind === "user" && actor.userId === contest.createdBy &&
        workspace.context.domainPermissions.has("contest:manage_own"),
    );
  const [problem] = await db.select({
    problemId: contestProblems.problem_id,
    pinnedVersionId: contestProblems.pinned_version_id,
  }).from(contestProblems).where(and(
    eq(contestProblems.contest_id, resolvedContestId),
    eq(contestProblems.problem_id, problemId),
  )).limit(1);
  if (!problem) {
    return { contestId: resolvedContestId, allowed: false, running: false };
  }
  const status = contestStatus(contest.startTime, contest.endTime);
  const [participant] = actor.kind === "user"
    ? await db.select({ userId: contestParticipants.user_id })
      .from(contestParticipants).where(and(
        eq(contestParticipants.contest_id, resolvedContestId),
        eq(contestParticipants.user_id, actor.userId),
      )).limit(1)
    : [];
  const protectedNow = status === "ended" &&
    (await loadPublicContestSecrecy(problemId, db, domainId)).length > 0;
  return {
    contestId: resolvedContestId,
    allowed: Boolean(participant) &&
      (status === "running" || status === "ended" && !protectedNow),
    running: status === "running",
    type: contest.type as ContestType,
    organizer,
    pinnedVersionId: problem.pinnedVersionId ?? null,
  };
}

/** 读取一场竞赛中题目的固定版本及策略，供 problems/evaluations 消费。 */
export async function getContestPolicySnapshot(
  contestId: string,
  problemId: string,
  executor: ReadExecutor = getDb(),
): Promise<ContestPolicySnapshot | null> {
  const [row] = await executor.select({
    contestId: contestProblems.contest_id,
    problemId: contestProblems.problem_id,
    pinnedVersionId: contestProblems.pinned_version_id,
    effectiveVersionMode: contestProblems.effective_version_mode,
    requiredVersionId: contestProblems.required_version_id,
    policyRevision: contestProblems.effective_policy_revision,
    config: contests.config,
    secrecyEnabled: contests.secrecy_enabled,
    startTime: contests.start_time,
    endTime: contests.end_time,
  }).from(contestProblems).innerJoin(
    contests,
    eq(contests.id, contestProblems.contest_id),
  ).where(and(
    eq(contestProblems.contest_id, contestId),
    eq(contestProblems.problem_id, problemId),
  )).limit(1);
  if (!row) return null;
  const config = row.config && typeof row.config === "object"
    ? row.config as { submission_limits?: Record<string, unknown> }
    : {};
  const configuredLimit = config.submission_limits?.[problemId];
  const submissionLimit = typeof configuredLimit === "number" &&
      Number.isSafeInteger(configuredLimit) && configuredLimit > 0
    ? configuredLimit
    : null;
  return {
    contestId: row.contestId,
    problemId: row.problemId,
    pinnedVersionId: row.pinnedVersionId,
    effectiveVersionMode: row.effectiveVersionMode as "any" | "exact",
    requiredVersionId: row.requiredVersionId,
    policyRevision: row.policyRevision,
    submissionLimit,
    running: contestStatus(row.startTime, row.endTime) === "running",
    secrecy: row.secrecyEnabled,
  };
}
