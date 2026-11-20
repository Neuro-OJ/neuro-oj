/** 重测任务（rejudge）的受理：请求校验、提交集合固定、条目计划、策略校验与受理事务。 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { AppError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor, RootDb } from "../../../../shared/db/executor.ts";
import {
  objectiveSubmissions,
  problems,
  problemVersions,
  submissionJobItems,
  submissionJobs,
  submissions,
} from "../../../../shared/db/schema.ts";
import {
  assertDefaultProblemSource,
  resolveDefaultExecutionContexts,
} from "../../../problems/contracts/cross-module/services_workspace_execution-context.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../../access/contracts/cross-module/workspace_services_access.ts";
import { DEFAULT_DOMAIN_SLUG } from "../../../../shared/workspace/types.ts";
import {
  lockEffectivePolicyHosts,
  setContestProblemEffectiveVersionPolicy,
  setProblemEffectiveVersionPolicy,
} from "./effective-policy.ts";
import {
  countItems,
  idempotencyConflict,
  insertJobItemsBatched,
  missingTargetVersion,
} from "./rejudge-common.ts";
import { hashRequest } from "./rejudge-hash.ts";
import {
  type AcceptJobResult,
  type JobSourceKind,
  MAX_SELECTED_SUBMISSIONS,
  type PlannedItem,
  type PolicyChangeRequest,
  type RejudgeRequest,
  type RejudgeScope,
  type RejudgeTarget,
} from "./rejudge-types.ts";

/** 校验请求结构，返回规范化后的请求对象。 */
export function normalizeRejudgeRequest(
  request: RejudgeRequest,
): RejudgeRequest {
  if (!request || request.kind !== "rejudge") {
    throw new AppError("任务类型必须是 rejudge", 400, "INVALID_JOB_KIND");
  }
  const scope = request.scope;
  if (!scope || typeof scope !== "object") {
    throw new AppError("缺少重测范围", 400, "INVALID_JOB_SCOPE");
  }
  if (scope.type === "selected") {
    if (!Array.isArray(scope.submissions)) {
      throw new AppError(
        "selected 范围必须给出 submissions 数组",
        400,
        "INVALID_JOB_SCOPE",
      );
    }
  } else if (scope.type === "problem") {
    if (!scope.problem_id) {
      throw new AppError("缺少 problem_id", 400, "INVALID_JOB_SCOPE");
    }
  } else if (scope.type === "contest") {
    if (!scope.contest_id) {
      throw new AppError("缺少 contest_id", 400, "INVALID_JOB_SCOPE");
    }
  } else {
    throw new AppError("不支持的重测范围", 400, "INVALID_JOB_SCOPE");
  }
  const target = request.target;
  if (!target || typeof target !== "object") {
    throw new AppError("缺少目标版本", 400, "INVALID_JOB_TARGET");
  }
  if (target.mode === "specified") {
    const versions = target.versions;
    if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
      throw new AppError(
        "specified 目标必须给出题目→版本映射",
        400,
        "INVALID_JOB_TARGET",
      );
    }
  } else if (target.mode !== "submitted" && target.mode !== "latest") {
    throw new AppError("不支持的目标版本模式", 400, "INVALID_JOB_TARGET");
  }
  return {
    kind: "rejudge",
    scope,
    target,
    policy_changes: request.policy_changes ?? [],
  };
}

/** 解析提交集合（受理时固定；去重后按首次出现顺序）。 */
async function resolveScopeItems(
  scope: RejudgeScope,
  executor: Executor,
): Promise<
  Array<
    {
      kind: JobSourceKind;
      id: string;
      domain_id: string | null;
      problem_id: string;
      submitted_version_id: string | null;
      contest_id: string | null;
    }
  >
> {
  const db = executor;
  if (scope.type === "selected") {
    if (scope.submissions.length > MAX_SELECTED_SUBMISSIONS) {
      throw new AppError(
        `手动所选提交不得超过 ${MAX_SELECTED_SUBMISSIONS} 条`,
        400,
        "TOO_MANY_SUBMISSIONS",
      );
    }
    // 受理时去重：同一提交只生成一个条目
    const seen = new Set<string>();
    const planned: Array<{
      kind: JobSourceKind;
      id: string;
      domain_id: string | null;
      problem_id: string;
      submitted_version_id: string | null;
      contest_id: string | null;
    }> = [];
    for (const entry of scope.submissions) {
      const key = `${entry.kind}:${entry.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (entry.kind === "submission") {
        const [row] = await db.select({
          id: submissions.id,
          domain_id: submissions.domain_id,
          problem_id: submissions.problem_id,
          submitted_version_id: submissions.submitted_version_id,
          contest_id: submissions.contest_id,
        }).from(submissions).where(eq(submissions.id, entry.id)).limit(1);
        if (row) {
          assertDefaultProblemSource(row);
          planned.push({ kind: "submission", ...row });
        }
        continue;
      }
      const [row] = await db.select({
        id: objectiveSubmissions.id,
        domain_id: objectiveSubmissions.domain_id,
        problem_id: objectiveSubmissions.paper_id,
        submitted_version_id: objectiveSubmissions.submitted_version_id,
        contest_id: objectiveSubmissions.contest_id,
      }).from(objectiveSubmissions).where(
        eq(objectiveSubmissions.id, entry.id),
      ).limit(1);
      if (row) {
        assertDefaultProblemSource(row);
        planned.push({ kind: "objective", ...row });
      }
    }
    return planned;
  }

  if (scope.type === "problem") {
    const plain = await db.select({
      id: submissions.id,
      domain_id: submissions.domain_id,
      problem_id: submissions.problem_id,
      submitted_version_id: submissions.submitted_version_id,
      contest_id: submissions.contest_id,
    }).from(submissions).where(
      and(
        eq(submissions.problem_id, scope.problem_id),
        sql`(${submissions.domain_id} IS NULL OR ${submissions.domain_id} = ${DEFAULT_DOMAIN_ID})`,
      ),
    );
    const objective = await db.select({
      id: objectiveSubmissions.id,
      domain_id: objectiveSubmissions.domain_id,
      problem_id: objectiveSubmissions.paper_id,
      submitted_version_id: objectiveSubmissions.submitted_version_id,
      contest_id: objectiveSubmissions.contest_id,
    }).from(objectiveSubmissions).where(
      and(
        eq(objectiveSubmissions.paper_id, scope.problem_id),
        sql`(${objectiveSubmissions.domain_id} IS NULL OR ${objectiveSubmissions.domain_id} = ${DEFAULT_DOMAIN_ID})`,
      ),
    );
    return [
      ...plain.map((row) => ({ kind: "submission" as const, ...row })),
      ...objective.map((row) => ({ kind: "objective" as const, ...row })),
    ];
  }

  const contestId = scope.contest_id;
  const plain = await db.select({
    id: submissions.id,
    domain_id: submissions.domain_id,
    problem_id: submissions.problem_id,
    submitted_version_id: submissions.submitted_version_id,
    contest_id: submissions.contest_id,
  }).from(submissions).where(
    and(
      eq(submissions.contest_id, contestId),
      sql`(${submissions.domain_id} IS NULL OR ${submissions.domain_id} = ${DEFAULT_DOMAIN_ID})`,
    ),
  );
  const objective = await db.select({
    id: objectiveSubmissions.id,
    domain_id: objectiveSubmissions.domain_id,
    problem_id: objectiveSubmissions.paper_id,
    submitted_version_id: objectiveSubmissions.submitted_version_id,
    contest_id: objectiveSubmissions.contest_id,
  }).from(objectiveSubmissions).where(
    and(
      eq(objectiveSubmissions.contest_id, contestId),
      sql`(${objectiveSubmissions.domain_id} IS NULL OR ${objectiveSubmissions.domain_id} = ${DEFAULT_DOMAIN_ID})`,
    ),
  );
  return [
    ...plain.map((row) => ({ kind: "submission" as const, ...row })),
    ...objective.map((row) => ({ kind: "objective" as const, ...row })),
  ];
}

/** 读取题目最新已发布版本。 */
async function latestVersionsOf(
  problemIds: string[],
  executor: Executor,
): Promise<Map<string, string>> {
  if (problemIds.length === 0) return new Map();
  const rows = await executor.select({
    id: problems.id,
    latest: problems.latest_version_id,
  }).from(problems).where(inArray(problems.id, problemIds));
  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.latest) out.set(row.id, row.latest);
  }
  return out;
}

/** 校验指定版本存在且属于对应题目。 */
async function assertSpecifiedVersionsUsable(
  versions: Record<string, string>,
  executor: Executor,
): Promise<void> {
  const problemIds = Object.keys(versions);
  if (problemIds.length === 0) return;
  const rows = await executor.select({
    problem_id: problemVersions.problem_id,
    id: problemVersions.id,
  }).from(problemVersions).where(
    inArray(problemVersions.problem_id, problemIds),
  );
  const available = new Set(rows.map((row) => `${row.problem_id}:${row.id}`));
  const missing = problemIds.filter((problemId) =>
    !available.has(`${problemId}:${versions[problemId]}`)
  );
  if (missing.length > 0) throw missingTargetVersion(missing);
}

/** 依据目标模式把解析后的提交集合变成条目计划。 */
export async function planItems(
  members: Array<{
    kind: JobSourceKind;
    id: string;
    problem_id: string;
    submitted_version_id: string | null;
  }>,
  target: RejudgeTarget,
  executor: Executor,
): Promise<PlannedItem[]> {
  const problemIds = [...new Set(members.map((member) => member.problem_id))];

  if (target.mode === "specified") {
    // 逐题映射必须覆盖所有涉及的题目，任一缺失整次受理失败
    const missing = problemIds.filter((problemId) =>
      !target.versions[problemId]
    );
    if (missing.length > 0) throw missingTargetVersion(missing);
    await assertSpecifiedVersionsUsable(target.versions, executor);
  }
  const latest = target.mode === "latest"
    ? await latestVersionsOf(problemIds, executor)
    : new Map<string, string>();
  if (target.mode === "latest") {
    const missing = problemIds.filter((problemId) => !latest.has(problemId));
    if (missing.length > 0) throw missingTargetVersion(missing);
  }

  return members.map((member) => {
    if (target.mode === "submitted") {
      if (!member.submitted_version_id) {
        return {
          source_kind: member.kind,
          source_id: member.id,
          problem_id: member.problem_id,
          target_version_id: null,
          target_version_ref: null,
          skipped_reason: {
            code: "LEGACY_VERSION_UNKNOWN",
            message: "提交时版本未知（存量历史提交），无法按提交时版本重测",
          },
        };
      }
      return {
        source_kind: member.kind,
        source_id: member.id,
        problem_id: member.problem_id,
        target_version_id: member.submitted_version_id,
        target_version_ref: member.submitted_version_id,
      };
    }
    const versionId = target.mode === "latest"
      ? latest.get(member.problem_id) as string
      : target.versions[member.problem_id];
    return {
      source_kind: member.kind,
      source_id: member.id,
      problem_id: member.problem_id,
      target_version_id: versionId,
      target_version_ref: versionId,
    };
  });
}

/**
 * 校验策略变更：作用域必须落在任务包含的题目/竞赛内，且 revision 匹配。
 *
 * 竞赛维度（#32）：`contest_id` 必须出现在任务实际包含的 `(contest_id, problem_id)`
 * 组合里——只按题目判断会允许"顺带改另一场竞赛同题的策略"。
 * 只做校验与读取，不写库；调用方在任何写入前调用。
 */
function validatePolicyChanges(
  changes: readonly PolicyChangeRequest[],
  jobProblemIds: ReadonlySet<string>,
  members: ReadonlyArray<{ problem_id: string; contest_id: string | null }> =
    [],
): void {
  for (const change of changes) {
    if (!jobProblemIds.has(change.problem_id)) {
      throw new AppError(
        `策略变更作用于任务范围之外的题目：${change.problem_id}`,
        400,
        "POLICY_CHANGE_OUT_OF_SCOPE",
      );
    }
    if (
      change.contest_id &&
      !members.some((member) =>
        member.problem_id === change.problem_id &&
        member.contest_id === change.contest_id
      )
    ) {
      throw new AppError(
        `策略变更作用于任务范围之外的竞赛：${change.contest_id}`,
        400,
        "POLICY_CHANGE_OUT_OF_SCOPE",
      );
    }
    if (!Number.isInteger(change.expected_revision)) {
      throw new AppError(
        "策略变更必须给出预期 revision",
        400,
        "POLICY_CHANGE_REVISION_REQUIRED",
      );
    }
    if (change.policy.mode === "exact" && !change.policy.version_id) {
      throw new AppError("exact 策略必须给出要求版本", 400, "INVALID_POLICY");
    }
    // revision 校验交给策略服务（同一事务语义），这里只做基础形态检查
  }
}

/**
 * 受理管理员重测任务。
 *
 * 锁序（Handbook §5.1）：受理事务在任何策略写入与投影重算**之前**，先按 ID 升序
 * 锁定全部相关题目，再按 ID 升序锁定全部相关竞赛，一次拿全；随后才进入策略写入、
 * 提交投影、revision 递增与条目写入。旧的"逐项改策略时边重算边取下一场竞赛锁"
 * 会在持有 global revision 锁的情况下继续抢竞赛锁，与并发批量受理成环（40P01）。
 *
 * @param actorId 操作者（幂等键与 actor 绑定）
 * @param idempotencyKey 客户端幂等键（必填）
 * @param testRootDb **测试专用注入点，生产调用一律省略**。真实 PostgreSQL 屏障用例
 *   需要注入一条独立原生根连接才能驱动本受理路径。
 *   **省略时行为完全不变**（走 `getDb()` 单例，事务与锁序语义一致）；无论是否注入，
 *   本函数都在自己的事务里执行全部读写，宿主锁持有到整批提交。
 */
export async function acceptRejudgeJob(
  actorId: string,
  request: RejudgeRequest,
  idempotencyKey: string,
  testRootDb?: RootDb,
): Promise<AcceptJobResult> {
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new AppError(
      "必须提供 Idempotency-Key（≤128 字符）",
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  const db = testRootDb ?? getDb();
  const normalized = normalizeRejudgeRequest(request);
  const requestHash = await hashRequest(normalized);

  // 幂等：先查同键任务
  const [existingJob] = await db.select().from(submissionJobs).where(
    and(
      eq(submissionJobs.actor_id, actorId),
      sql`(${submissionJobs.domain_id} IS NULL OR ${submissionJobs.domain_id} = ${DEFAULT_DOMAIN_ID})`,
      eq(submissionJobs.kind, "rejudge"),
      eq(submissionJobs.idempotency_key, idempotencyKey),
    ),
  ).limit(1);
  if (existingJob) {
    if (existingJob.request_hash !== requestHash) {
      throw idempotencyConflict();
    }
    return {
      job_id: existingJob.id,
      status: existingJob.status,
      total_items: await countItems(existingJob.id, db),
      existing: true,
    };
  }

  let planned: PlannedItem[] = [];
  const now = new Date().toISOString();
  const jobId = crypto.randomUUID();
  let jobStatus: "queued" | "completed" = "queued";
  try {
    const write = async (tx: Executor): Promise<void> => {
      if (
        (normalized.policy_changes ?? []).some((change) => !change.contest_id)
      ) {
        const workspace = await loadWorkspace(DEFAULT_DOMAIN_SLUG, actorId, {
          executor: tx,
          write: true,
          lock: true,
        });
        assertWorkspacePermission(workspace.context, "problem:policy");
      }
      const members = await resolveScopeItems(normalized.scope, tx);
      const contexts = await resolveDefaultExecutionContexts(
        members.map((member) => member.problem_id),
        actorId,
        tx,
      );
      planned = await planItems(members, normalized.target, tx);
      // §4.3：策略变更必须显式作用域，且只能作用于任务包含的题目/竞赛。
      // 任何写入前完成全部校验（题目维度 + 竞赛维度 + revision 形态）。
      validatePolicyChanges(
        normalized.policy_changes ?? [],
        new Set(planned.map((item) => item.problem_id)),
        members,
      );
      // §5.1 固定锁序：**先按 ID 升序锁定全部相关题目，再按 ID 升序锁定全部相关
      // 竞赛（去重）**，一次拿全；全部宿主锁到手后才进入策略写入、提交投影、
      // revision 递增与条目写入阶段。
      //
      // 相关宿主 = 本次批量策略修改要改写的宿主（`policy_changes` 的题目与竞赛）：
      // 题库策略写在 main 绑定行上（域锁已先取得）、竞赛策略写在 `contest_problems` 行上，
      // 两者的投影重算分别写提交行并递增 `problem:*` / `contest:*` / `global`
      // 的 projection revision。
      //
      // 反例（修复前）：先只锁题目，再按 changes 顺序逐项"取竞赛锁 → 重算投影 →
      // 递增 global revision"，于是一个请求可能已持有 global revision 锁却仍在
      // 抢下一场竞赛锁；两批**题目不相交、竞赛相交**的请求各自先拿到一场对方
      // 也要的竞赛 → 环 → PostgreSQL 40P01。`changes.sort()` 只是必要条件：
      // 题目升序无法决定竞赛的获取顺序。
      const changes = [...(normalized.policy_changes ?? [])].sort((a, b) =>
        a.problem_id.localeCompare(b.problem_id) ||
        (a.contest_id ?? "").localeCompare(b.contest_id ?? "")
      );
      await lockEffectivePolicyHosts(tx, {
        problemIds: changes.map((change) => change.problem_id),
        contestIds: changes.map((change) => change.contest_id).filter(
          (contestId): contestId is string => !!contestId,
        ),
      });
      for (const change of changes) {
        const input = {
          policy: change.policy,
          expectedRevision: change.expected_revision,
          actorId,
        };
        if (change.contest_id) {
          await setContestProblemEffectiveVersionPolicy(
            change.contest_id,
            change.problem_id,
            input,
            tx,
          );
        } else {await setProblemEffectiveVersionPolicy(
            change.problem_id,
            input,
            tx,
          );}
      }
      jobStatus = planned.every((item) => item.skipped_reason)
        ? "completed"
        : "queued";
      await tx.insert(submissionJobs).values({
        id: jobId,
        domain_id: DEFAULT_DOMAIN_ID,
        kind: "rejudge",
        actor_id: actorId,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        request: normalized as unknown as Record<string, unknown>,
        status: jobStatus,
        created_at: now,
        finished_at: jobStatus === "completed" ? now : null,
      });
      if (planned.length > 0) {
        await insertJobItemsBatched(
          tx,
          planned.map((
            item,
            index,
          ): typeof submissionJobItems.$inferInsert => ({
            id: crypto.randomUUID(),
            job_id: jobId,
            ordinal: index,
            source_kind: item.source_kind,
            source_id: item.source_id,
            problem_id: item.problem_id,
            domain_id: DEFAULT_DOMAIN_ID,
            domain_problem_binding_id:
              contexts.get(item.problem_id)?.domain_problem_binding_id ?? null,
            target_version_id: item.target_version_id,
            target_version_ref: item.target_version_ref,
            status: item.skipped_reason ? "skipped" : "pending",
            reason_code: item.skipped_reason?.code ?? null,
            reason_message: item.skipped_reason?.message ?? null,
            created_at: now,
            finished_at: item.skipped_reason ? now : null,
          })),
        );
      }
    };
    // 必须在**自己的事务**里执行：宿主锁与全部写入要么一起提交，要么一起回滚。
    // （测试注入根连接时同样在此开启真实事务；否则语句各自 autocommit，
    // 预取的宿主锁会在下一条语句前释放，锁序协议就失去意义。）
    await db.transaction((tx) => write(tx));
  } catch (error) {
    // 注入测试根连接时不重读：由调用方决定回滚与错误映射（屏障测试要观察原始错误）。
    if (testRootDb) throw error;
    // 幂等键竞态：并发受理同键 → 返回先写入的那个任务
    const [raced] = await db.select().from(submissionJobs).where(
      and(
        eq(submissionJobs.actor_id, actorId),
        sql`(${submissionJobs.domain_id} IS NULL OR ${submissionJobs.domain_id} = ${DEFAULT_DOMAIN_ID})`,
        eq(submissionJobs.kind, "rejudge"),
        eq(submissionJobs.idempotency_key, idempotencyKey),
      ),
    ).limit(1);
    if (raced) {
      if (raced.request_hash !== requestHash) throw idempotencyConflict();
      return {
        job_id: raced.id,
        status: raced.status,
        total_items: await countItems(raced.id, db),
        existing: true,
      };
    }
    throw error;
  }

  return {
    job_id: jobId,
    status: jobStatus,
    total_items: planned.length,
    existing: false,
  };
}
