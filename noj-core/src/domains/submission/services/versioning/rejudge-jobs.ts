/**
 * 批任务受理（Handbook §2.10、§4.3、§5.7 前半）。
 *
 * 管理员重测与用户升级共用 `submission_jobs` / `submission_job_items` 两张表，
 * 本文件实现**受理**（把请求变成固定的条目集合）与任务读取，worker 负责派发。
 *
 * 受理语义：
 * - `Idempotency-Key` 与 actor 绑定：同键同请求返回原任务，同键不同请求 → 409；
 * - **受理时同时固定提交集合**：之后产生的新提交不进入本批任务；
 * - `submitted` 用不可变提交时版本；未知历史版本 → 条目 `skipped`
 *   （`LEGACY_VERSION_UNKNOWN`），不整批拒绝；
 * - `latest` / `specified` 在受理事务中解析并固定到条目
 *   （`target_version_id` + `target_version_ref`）；
 * - 界面"全部用 V3"展开成逐题映射后，任一题没有该版本 → **整次受理 400**，
 *   不产生任务、不改策略；
 * - `policy_changes` 必须显式列出作用域与预期 revision，且只能作用于任务包含的
 *   题目/竞赛；校验全部通过后才应用策略并建任务；
 * - 手动所选上限 500；整题/整场无总量上限（后台分批）。
 */

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
  canonicalJson,
  resolveDefaultExecutionContexts,
} from "../../../../modules/problems/index.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import {
  assertWorkspacePermission,
  DEFAULT_DOMAIN_SLUG,
  loadWorkspace,
} from "../../../workspace/index.ts";
import type {
  EffectiveVersionPolicy,
  SubmissionJobItemStatus,
} from "../../../../shared/versioning/types.ts";
import {
  lockEffectivePolicyHosts,
  setContestProblemEffectiveVersionPolicy,
  setProblemEffectiveVersionPolicy,
} from "./effective-policy.ts";

/** 手动所选提交上限。 */
export const MAX_SELECTED_SUBMISSIONS = 500;
/** worker 单次领取上限（§5.7）。 */
export const MAX_JOB_ITEMS_PER_CLAIM = 100;
/**
 * 单条 `INSERT` 的条目批大小（#41）。
 *
 * 整题/整场任务没有 500 条上限，条目数可达数万；一次插入全部行会超出 PostgreSQL
 * 单语句 65535 个绑定参数的上限。所有写条目的路径统一走 `insertJobItemsBatched`。
 */
export const JOB_ITEM_INSERT_BATCH = MAX_JOB_ITEMS_PER_CLAIM;

/**
 * 分批插入任务条目（#41）。
 *
 * 保持调用方的事务上下文：分批只影响单语句规模，成员集合仍在受理事务内固定。
 */
export async function insertJobItemsBatched(
  executor: Executor,
  rows: ReadonlyArray<typeof submissionJobItems.$inferInsert>,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += JOB_ITEM_INSERT_BATCH) {
    await executor.insert(submissionJobItems).values(
      rows.slice(offset, offset + JOB_ITEM_INSERT_BATCH),
    );
  }
}

/** 条目来源。 */
export type JobSourceKind = "submission" | "objective";

/** 重测范围。 */
export type RejudgeScope =
  | {
    type: "selected";
    submissions: Array<{ kind: JobSourceKind; id: string }>;
  }
  | { type: "problem"; problem_id: string }
  | { type: "contest"; contest_id: string };

/** 重测目标版本。 */
export type RejudgeTarget =
  | { mode: "submitted" }
  | { mode: "latest" }
  | { mode: "specified"; versions: Record<string, string> };

/** 策略变更请求。 */
export interface PolicyChangeRequest {
  problem_id: string;
  contest_id?: string;
  expected_revision: number;
  policy: EffectiveVersionPolicy;
}

/** 管理员重测请求体（§4.3）。 */
export interface RejudgeRequest {
  kind: "rejudge";
  scope: RejudgeScope;
  target: RejudgeTarget;
  policy_changes?: PolicyChangeRequest[];
}

/** 受理结果。 */
export interface AcceptJobResult {
  job_id: string;
  status: string;
  total_items: number;
  /** 已存在同幂等键任务时为 true（未新建）。 */
  existing: boolean;
}

/** 条目读模型。 */
export interface JobItemView {
  id: string;
  ordinal: number;
  source_kind: JobSourceKind;
  source_id: string;
  problem_id: string;
  target_version_id: string | null;
  target_version_ref: string | null;
  status: string;
  attempt_id: string | null;
  reason_code: string | null;
  reason_message: string | null;
}

/** 任务读模型。 */
export interface JobView {
  id: string;
  kind: string;
  actor_id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  /** 由条目聚合的计数（不维护进程内计数器）。 */
  counts: Record<string, number>;
  total_items: number;
}

/** 受理前的规范化条目。 */
interface PlannedItem {
  source_kind: JobSourceKind;
  source_id: string;
  problem_id: string;
  target_version_id: string | null;
  target_version_ref: string | null;
  skipped_reason?: { code: string; message: string };
}

/** 409：幂等键复用但请求不同。 */
export function idempotencyConflict(): AppError {
  return new AppError(
    "该 Idempotency-Key 已用于不同的请求",
    409,
    "IDEMPOTENCY_KEY_REUSED",
  );
}

/** 400：部分题目缺少指定版本（整次受理失败）。 */
export function missingTargetVersion(problemIds: string[]): AppError {
  return new AppError(
    `指定的目标版本缺失：${
      problemIds.join(", ")
    }（整次受理已拒绝，未产生任务）`,
    400,
    "TARGET_VERSION_MISSING",
  );
}

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
    if (existingJob.request_hash !== requestHash) throw idempotencyConflict();
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

/** 规范化载荷的 SHA-256（相同语义请求必须得到相同哈希）。 */
export async function hashCanonical(value: unknown): Promise<string> {
  const payload = canonicalJson(value);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** 请求规范化哈希（相同请求必须得到相同哈希）。 */
export async function hashRequest(request: RejudgeRequest): Promise<string> {
  const payload = canonicalJson({
    kind: request.kind,
    scope: request.scope,
    target: request.target,
    policy_changes: (request.policy_changes ?? []).map((change) => ({
      problem_id: change.problem_id,
      contest_id: change.contest_id ?? null,
      expected_revision: change.expected_revision,
      policy: change.policy,
    })),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
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

/** 统计任务条目数。 */
async function countItems(jobId: string, executor: Executor): Promise<number> {
  const [row] = await executor.select({
    count: sql<number>`count(*)::int`,
  }).from(submissionJobItems).where(eq(submissionJobItems.job_id, jobId));
  return row?.count ?? 0;
}

/** 读取任务（含按状态聚合的计数）。 */
export async function getRejudgeJob(jobId: string): Promise<JobView | null> {
  const db = getDb();
  const [job] = await db.select().from(submissionJobs).where(
    eq(submissionJobs.id, jobId),
  ).limit(1);
  if (!job) return null;
  const counts = await countItemsByStatus(jobId, db);
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    id: job.id,
    kind: job.kind,
    actor_id: job.actor_id,
    status: job.status,
    created_at: job.created_at,
    finished_at: job.finished_at,
    counts,
    total_items: total,
  };
}

/** 按状态聚合条目计数（不维护进程内计数器）。 */
export async function countItemsByStatus(
  jobId: string,
  executor: Executor,
): Promise<Record<string, number>> {
  const rows = await executor.select({
    status: submissionJobItems.status,
    count: sql<number>`count(*)::int`,
  }).from(submissionJobItems).where(eq(submissionJobItems.job_id, jobId))
    .groupBy(submissionJobItems.status);
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = row.count;
  return out;
}

/** 分页读取任务条目。 */
export async function listRejudgeJobItems(
  jobId: string,
  options: {
    page?: number;
    perPage?: number;
    status?: SubmissionJobItemStatus;
  } = {},
): Promise<{ data: JobItemView[]; total: number }> {
  const db = getDb();
  const page = Math.max(1, options.page ?? 1);
  const perPage = Math.min(100, Math.max(1, options.perPage ?? 20));
  const where = options.status
    ? and(
      eq(submissionJobItems.job_id, jobId),
      eq(submissionJobItems.status, options.status),
    )
    : eq(submissionJobItems.job_id, jobId);
  const [countRow] = await db.select({
    count: sql<number>`count(*)::int`,
  }).from(submissionJobItems).where(where);
  const rows = await db.select().from(submissionJobItems).where(where)
    .orderBy(submissionJobItems.ordinal)
    .limit(perPage).offset((page - 1) * perPage);
  return {
    data: rows.map((row) => ({
      id: row.id,
      ordinal: row.ordinal,
      source_kind: row.source_kind,
      source_id: row.source_id,
      problem_id: row.problem_id,
      target_version_id: row.target_version_id,
      target_version_ref: row.target_version_ref,
      status: row.status,
      attempt_id: row.attempt_id,
      reason_code: row.reason_code,
      reason_message: row.reason_message,
    })),
    total: countRow?.count ?? 0,
  };
}

/**
 * 依据条目状态推导并写入任务终态（§5.7「job 状态与统计由持久化条目推导」）。
 *
 * 全部条目进入终态（succeeded/failed/skipped）后：有 failed → `completed_with_errors`，
 * 否则 `completed`。
 *
 * #39（不得从 completed 回退 running）：聚合读取与任务更新必须在**同一事务内、
 * 持有任务行锁之后**执行。`FOR UPDATE` 先把并发聚合串行化，随后在同一事务内
 * 重新统计条目，因此后进入的调用必然看到先前调用已提交的条目终态，
 * 过时的「还有在途条目」结果无法再写回任务行。
 */
export async function refreshJobStatus(
  jobId: string,
  executor?: Executor,
): Promise<string> {
  if (!executor) {
    return await getDb().transaction((tx) => refreshJobStatus(jobId, tx));
  }
  const db = executor;
  await db.select({ id: submissionJobs.id }).from(submissionJobs).where(
    eq(submissionJobs.id, jobId),
  ).for("update");
  const counts = await countItemsByStatus(jobId, db);
  const pending = (counts.pending ?? 0) + (counts.preparing ?? 0) +
    (counts.dispatched ?? 0);
  if (pending > 0) {
    const status = (counts.dispatched ?? 0) > 0 ? "running" : "queued";
    await db.update(submissionJobs).set({ status, finished_at: null }).where(
      eq(submissionJobs.id, jobId),
    );
    return status;
  }
  const status = (counts.failed ?? 0) > 0
    ? "completed_with_errors"
    : "completed";
  await db.update(submissionJobs).set({
    status,
    finished_at: new Date().toISOString(),
  }).where(eq(submissionJobs.id, jobId));
  return status;
}

/**
 * 重试任务的幂等身份（#40）。
 *
 * 必须覆盖**父任务类型 + 父任务 ID + 规范化重试条目 + 固定目标版本映射**：
 * 只哈希 `retry_of` 无法区分条目集合已经变化的重试，也无法区分不同 kind 的父任务；
 * 不同父任务复用同一 Idempotency-Key 必须 409，不能错误返回同一个重试任务。
 */
export async function hashRetryRequest(
  parentKind: string,
  parentJobId: string,
  items: ReadonlyArray<{
    ordinal: number;
    source_kind: JobSourceKind;
    source_id: string;
    target_version_id: string | null;
    target_version_ref: string | null;
  }>,
): Promise<string> {
  return await hashCanonical({
    kind: "rejudge_retry",
    parent_kind: parentKind,
    parent_job_id: parentJobId,
    items: [...items].sort((a, b) => a.ordinal - b.ordinal).map((item) => ({
      ordinal: item.ordinal,
      source_kind: item.source_kind,
      source_id: item.source_id,
      target_version_id: item.target_version_id,
      target_version_ref: item.target_version_ref,
    })),
  });
}

/**
 * 重试任务：只包含 `failed` / `skipped` 条目，生成**关联新任务**，
 * 保留目标版本映射，**不再次修改有效策略**。
 *
 * 锁序（Handbook §5.1）：本入口不写有效策略、不重算投影（重试请求的
 * `policy_changes` 恒为空，条目沿用父任务固定的目标版本），因此不获取任何
 * 题目/竞赛宿主锁，只在本事务内插入 `submission_jobs` / `submission_job_items`
 * 行——不参与「题目 → 竞赛 → 提交 → 尝试 → revision」争用，也就不可能与批量
 * 策略修改入口互相成环。若将来在此引入策略/竞赛锁，必须改为调用
 * `lockEffectivePolicyHosts` 一次拿全（题目升序 → 竞赛升序），而不是逐项获取。
 */
export async function retryRejudgeJob(
  actorId: string,
  jobId: string,
  idempotencyKey: string,
): Promise<AcceptJobResult> {
  const db = getDb();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new AppError(
      "必须提供 Idempotency-Key（≤128 字符）",
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  const [job] = await db.select().from(submissionJobs).where(
    eq(submissionJobs.id, jobId),
  ).limit(1);
  if (!job) {
    throw new AppError("任务不存在", 404, "JOB_NOT_FOUND");
  }
  // 父任务必须存在且为 rejudge：升级任务不能被解释成重测（#40）
  if (job.kind !== "rejudge") {
    throw new AppError("仅能重试重测任务", 400, "INVALID_JOB_KIND");
  }
  const retryable = await db.select().from(submissionJobItems).where(
    and(
      eq(submissionJobItems.job_id, jobId),
      inArray(
        submissionJobItems.status,
        ["failed", "skipped"] as SubmissionJobItemStatus[],
      ),
    ),
  ).orderBy(submissionJobItems.ordinal);
  if (retryable.length === 0) {
    throw new AppError(
      "该任务没有可重试的条目（仅 failed/skipped 可重试）",
      400,
      "NO_RETRYABLE_ITEMS",
    );
  }

  const request = job.request as unknown as RejudgeRequest;
  const requestHash = await hashRetryRequest(job.kind, jobId, retryable);
  const existing = await db.select().from(submissionJobs).where(
    and(
      eq(submissionJobs.actor_id, actorId),
      sql`(${submissionJobs.domain_id} IS NULL OR ${submissionJobs.domain_id} = ${DEFAULT_DOMAIN_ID})`,
      eq(submissionJobs.kind, "rejudge"),
      eq(submissionJobs.idempotency_key, idempotencyKey),
    ),
  ).limit(1);
  if (existing[0]) {
    if (existing[0].request_hash !== requestHash) throw idempotencyConflict();
    return {
      job_id: existing[0].id,
      status: existing[0].status,
      total_items: await countItems(existing[0].id, db),
      existing: true,
    };
  }

  const now = new Date().toISOString();
  const newJobId = crypto.randomUUID();
  const rows = retryable.map(
    (item, index): typeof submissionJobItems.$inferInsert => ({
      id: crypto.randomUUID(),
      domain_id: DEFAULT_DOMAIN_ID,
      job_id: newJobId,
      ordinal: index,
      source_kind: item.source_kind,
      source_id: item.source_id,
      problem_id: item.problem_id,
      target_version_id: item.target_version_id,
      target_version_ref: item.target_version_ref,
      status: "pending",
      created_at: now,
    }),
  );
  try {
    await db.transaction(async (tx) => {
      const contexts = await resolveDefaultExecutionContexts(
        rows.map((row) => row.problem_id),
        actorId,
        tx,
      );
      for (const row of rows) {
        const context = contexts.get(row.problem_id);
        row.domain_problem_binding_id = context?.domain_problem_binding_id ??
          null;
        if (!context) {
          row.status = "skipped";
          row.reason_code = "SOURCE_DELETED";
          row.reason_message = "源题已不存在，不能重新评测";
          row.finished_at = now;
        }
      }
      const complete = rows.every((row) => row.status === "skipped");
      await tx.insert(submissionJobs).values({
        id: newJobId,
        domain_id: DEFAULT_DOMAIN_ID,
        kind: "rejudge",
        actor_id: actorId,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        request: {
          ...request,
          retry_of: jobId,
          policy_changes: [],
        } as unknown as Record<string, unknown>,
        status: complete ? "completed" : "queued",
        created_at: now,
        finished_at: complete ? now : null,
      });
      // 整题/整场任务的重试条目数可达数万：分批插入（#41）
      await insertJobItemsBatched(tx, rows);
    });
  } catch (error) {
    // 并发受理同一幂等键：唯一索引 (actor_id, kind, idempotency_key) 冲突后
    // 必须重读已提交任务并核对请求哈希，而不是把 23505 抛给调用方（#40）
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
    job_id: newJobId,
    status: rows.every((row) => row.status === "skipped")
      ? "completed"
      : "queued",
    total_items: retryable.length,
    existing: false,
  };
}
