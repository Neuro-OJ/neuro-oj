/**
 * 评测尝试的生命周期（Handbook §2.8、§5.4）。
 *
 * 一次「使用某个题目版本评测某条提交」= 一条 `evaluation_attempts` 记录，
 * 其 `id` 同时作为正式评测的 `run_id`。规则：
 *
 * - 新提交的初次尝试 `sequence = 0`，重测/升级递增 sequence；
 * - 创建尝试时同时把提交的 `active_attempt_id` 指向它（在途任务），
 *   但**不触碰**任何有效成绩指针（§5.4 第 6 步：保留已有分版本判定与有效成绩）；
 * - **终态只可写入一次**：重复回调、过时回调都不覆盖结果；
 * - 平台错误是终态，但不更新分版本当前判定（§2.9）。
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  evaluationAttempts,
  objectiveSubmissions,
  problemVersions,
  submissions,
} from "../../../../shared/db/schema.ts";
import type {
  AttemptResultKind,
  AttemptSource,
} from "../../../../shared/versioning/types.ts";
import { lockProjectionHosts, type ProjectionSource } from "./projection.ts";
import { AppError } from "../../../../shared/base/errors.ts";

/** 尝试创建输入。 */
export interface CreateAttemptInput {
  /**
   * 显式指定尝试 ID；缺省生成。
   *
   * 正式提交必须在派发任务**之前**确定该 ID：任务里的 `run_id` 等于它，
   * judge 回传后 core 才能把结果精确落到对应尝试（Handbook §5.5）。
   */
  id?: string;
  source: ProjectionSource;
  /** 本次执行使用的题目版本；存量历史为 null。 */
  problemVersionId: string | null;
  source_kind: AttemptSource;
  /** 实际执行快照（语言、版本、平台计时标准、LLM Provider/模型与预算）。 */
  taskSnapshot?: Record<string, unknown> | null;
  createdBy?: string | null;
  executor?: Executor;
  /** 显式指定 sequence（升级/批任务用）；缺省取 MAX+1。 */
  sequence?: number;
}

/** 尝试终态写入输入。 */
export interface FinishAttemptInput {
  attemptId: string;
  resultKind: AttemptResultKind;
  resultStatus: string | null;
  score: number | null;
  accepted: boolean;
  output?: string;
  details?: Record<string, unknown>;
  timeMs?: number | null;
  memoryKb?: number | null;
}

/** 尝试记录（读模型）。 */
export interface AttemptRecord {
  id: string;
  submission_id: string | null;
  objective_submission_id: string | null;
  problem_id: string;
  problem_version_id: string | null;
  sequence: number;
  source: AttemptSource;
  state: string;
  result_kind: AttemptResultKind | null;
  created_at: string;
}

/** 是否为终态。 */
export function isTerminalAttemptState(state: string): boolean {
  return state === "finished" || state === "error" || state === "superseded";
}

/** 读取尝试；不存在返回 null。 */
export async function getAttempt(
  attemptId: string,
  executor?: Executor,
): Promise<AttemptRecord | null> {
  const db = executor ?? getDb();
  const [row] = await db.select().from(evaluationAttempts).where(
    eq(evaluationAttempts.id, attemptId),
  ).limit(1);
  return (row as AttemptRecord | undefined) ?? null;
}

/** 下一个 sequence（同一提交内递增）。 */
export async function nextAttemptSequence(
  source: ProjectionSource,
  executor?: Executor,
): Promise<number> {
  const db = executor ?? getDb();
  const column = source.kind === "submission"
    ? evaluationAttempts.submission_id
    : evaluationAttempts.objective_submission_id;
  const [row] = await db.select({
    max: sql<number>`COALESCE(MAX(${evaluationAttempts.sequence}), -1)::int`,
  }).from(evaluationAttempts).where(eq(column, source.id));
  return (row?.max ?? -1) + 1;
}

/**
 * 创建尝试并把提交的 `active_attempt_id` 指向它。
 *
 * 调用方负责在事务内先锁定提交行（§5.1 锁顺序），并确认没有其他在途尝试。
 */
export async function createAttempt(
  input: CreateAttemptInput,
): Promise<AttemptRecord> {
  if (!input.executor) {
    return await getDb().transaction((tx) =>
      createAttempt({ ...input, executor: tx })
    );
  }
  const db = input.executor ?? getDb();
  await lockProjectionHosts(db, input.source);
  const sourceTable = input.source.kind === "submission"
    ? submissions
    : objectiveSubmissions;
  const problemColumn = input.source.kind === "submission"
    ? submissions.problem_id
    : objectiveSubmissions.paper_id;
  const [locked] = await db.select({
    active: sourceTable.active_attempt_id,
    problem_id: problemColumn,
    contest_id: sourceTable.contest_id,
    // 迁移前旧协议在提交行上维护的重测序号。新尝试的 sequence 不得低于它，
    // 否则"rejudge_seq=5、无尝试行"的存量提交再重测会得到 sequence 0，
    // 任务透传与结果封套校验随之错位（tracking #27）。
    rejudge_seq: sourceTable.rejudge_seq,
  })
    .from(sourceTable).where(eq(sourceTable.id, input.source.id)).for("update");
  if (!locked) throw new AppError("提交不存在", 404, "SUBMISSION_NOT_FOUND");
  if (
    locked.problem_id !== input.source.problem_id ||
    (input.source.contest_id !== undefined &&
      input.source.contest_id !== locked.contest_id)
  ) {
    throw new AppError(
      "尝试与源提交不属于同一题目或竞赛",
      409,
      "ATTEMPT_SOURCE_MISMATCH",
    );
  }
  if (!input.problemVersionId && input.source_kind !== "legacy_import") {
    throw new AppError("新尝试必须使用已发布版本", 400, "VERSION_REQUIRED");
  }
  if (input.problemVersionId) {
    const [version] = await db.select({ id: problemVersions.id }).from(
      problemVersions,
    ).where(and(
      eq(problemVersions.id, input.problemVersionId),
      eq(problemVersions.problem_id, locked.problem_id),
    ));
    if (!version) {
      throw new AppError("评测版本不属于该题", 400, "PROBLEM_VERSION_MISMATCH");
    }
  }
  if (locked.active) {
    const active = await getAttempt(locked.active, db);
    if (active && !isTerminalAttemptState(active.state)) {
      throw new AppError("源提交正在评测", 409, "SOURCE_JUDGING");
    }
  }
  // sequence 单调不减：取 MAX(尝试)+1 与提交行既有 `rejudge_seq` 的较大者。
  // 旧协议迁移过来的提交可能带着更大的源序号而没有任何尝试行（tracking #27）。
  const sequence = Math.max(
    input.sequence ?? await nextAttemptSequence(input.source, db),
    locked.rejudge_seq ?? 0,
  );
  const id = input.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(evaluationAttempts).values({
    id,
    submission_id: input.source.kind === "submission" ? input.source.id : null,
    objective_submission_id: input.source.kind === "objective"
      ? input.source.id
      : null,
    problem_id: input.source.problem_id,
    problem_version_id: input.problemVersionId,
    sequence,
    source: input.source_kind,
    state: "queued",
    task_snapshot: input.taskSnapshot ?? null,
    created_by: input.createdBy ?? null,
    created_at: now,
  });
  if (input.source.kind === "submission") {
    // 在途尝试期间提交必须是 `pending`：
    // - 结果写入的状态机只接受 pending/judging（否则整条结果被丢弃）；
    // - producer 只在 pending/judging 时记录 `judge_run_id`，而该字段是结果
    //   归属校验（协议 v2 `run_id`）的兜底依据——重测不刷新它会把新结果误判为
    //   过时消息（2026-10-10 实测：任务化重测的结果被"重复/过时"忽略）。
    // 正式提交 `run_id = attempt_id`（Handbook §5.5），因此这里直接落 attempt id。
    await db.update(submissions).set({
      active_attempt_id: id,
      status: "pending",
      judge_run_id: id,
      rejudge_seq: sequence,
      judge_finished_at: null,
    }).where(eq(submissions.id, input.source.id));
  } else {
    await db.update(objectiveSubmissions).set({
      active_attempt_id: id,
      rejudge_seq: sequence,
    }).where(
      eq(objectiveSubmissions.id, input.source.id),
    );
  }
  return {
    id,
    submission_id: input.source.kind === "submission" ? input.source.id : null,
    objective_submission_id: input.source.kind === "objective"
      ? input.source.id
      : null,
    problem_id: input.source.problem_id,
    problem_version_id: input.problemVersionId,
    sequence,
    source: input.source_kind,
    state: "queued",
    result_kind: null,
    created_at: now,
  };
}

/** 标记尝试进入执行中（幂等：已是终态或已 judging 时不动）。 */
export async function markAttemptStarted(
  attemptId: string,
  executor?: Executor,
): Promise<void> {
  const db = executor ?? getDb();
  await db.update(evaluationAttempts).set({
    state: "judging",
    started_at: new Date().toISOString(),
  }).where(
    and(
      eq(evaluationAttempts.id, attemptId),
      eq(evaluationAttempts.state, "queued"),
    ),
  );
}

/**
 * **一次性**写入尝试终态。
 *
 * 只有当前状态不是终态时才写入，返回是否真的应用了结果——
 * 重复消息、乱序消息、已被 superseded 的旧尝试都会得到 `false`。
 */
export async function finishAttempt(
  input: FinishAttemptInput,
  executor?: Executor,
): Promise<boolean> {
  const db = executor ?? getDb();
  const now = new Date().toISOString();
  const rows = await db.update(evaluationAttempts).set({
    state: input.resultKind === "graded" ? "finished" : "error",
    result_kind: input.resultKind,
    result_status: input.resultStatus,
    score: input.score,
    accepted: input.accepted,
    output: input.output ?? "",
    details: input.details ?? {},
    time_ms: input.timeMs ?? null,
    memory_kb: input.memoryKb ?? null,
    finished_at: now,
  }).where(
    and(
      eq(evaluationAttempts.id, input.attemptId),
      sql`${evaluationAttempts.state} NOT IN ('finished', 'error', 'superseded')`,
    ),
  ).returning({ id: evaluationAttempts.id });
  return rows.length > 0;
}

/**
 * 把尝试标记为过时（真正超时且已创建新执行时使用）。
 *
 * **终态后必须吊销该尝试已签发的 LLM token**（Handbook §6.7）：被 superseded 的
 * 旧尝试若不在剩余有效期内吊销，旧 token 会在剩余 TTL 内继续可用。吊销是外部
 * 副作用，**只能在业务事务提交后执行**，因此：
 *
 * - 未传 `executor`（本函数自行开事务）：提交后立即吊销，返回是否真的置为过时；
 * - 传入 `executor`（调用方事务尚未提交）：**本函数不吊销**，调用方必须在提交后
 *   自行调用 `revokeAttemptLlmTokens({ attemptId })`（幂等）。
 *
 * @returns 是否真的把该尝试置为 `superseded`（已是终态时返回 false）
 */
export async function supersedeAttempt(
  attemptId: string,
  executor?: Executor,
): Promise<boolean> {
  const apply = async (db: Executor): Promise<boolean> => {
    const rows = await db.update(evaluationAttempts).set({
      state: "superseded",
      finished_at: new Date().toISOString(),
    }).where(
      and(
        eq(evaluationAttempts.id, attemptId),
        sql`${evaluationAttempts.state} NOT IN ('finished', 'error', 'superseded')`,
      ),
    ).returning({ id: evaluationAttempts.id });
    return rows.length > 0;
  };

  if (executor) return await apply(executor);

  const applied = await getDb().transaction((tx) => apply(tx));
  if (applied) await revokeSupersededAttemptTokens(attemptId);
  return applied;
}

/**
 * 终态提交后吊销该尝试的 token（动态导入 job-worker，避免
 * attempts → job-worker → result-write → attempts 的静态循环）。
 *
 * 同时写尝试维度键与提交维度旧键；Redis 不可用/失败时静默（不影响已提交终态，
 * 由 sweeper 与日志兜底）。
 */
async function revokeSupersededAttemptTokens(attemptId: string): Promise<void> {
  try {
    const attempt = await getAttempt(attemptId);
    const { revokeAttemptLlmTokens } = await import("./job-worker.ts");
    await revokeAttemptLlmTokens({
      attemptId,
      submissionId: attempt?.submission_id ?? null,
    });
  } catch {
    // 吊销失败不得影响已提交的业务终态
  }
}
