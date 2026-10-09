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
  submissions,
} from "../../../../shared/db/schema.ts";
import type {
  AttemptResultKind,
  AttemptSource,
} from "../../../../shared/versioning/types.ts";
import type { ProjectionSource } from "./projection.ts";

/** 尝试创建输入。 */
export interface CreateAttemptInput {
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
  const db = input.executor ?? getDb();
  const sequence = input.sequence ??
    await nextAttemptSequence(input.source, db);
  const id = crypto.randomUUID();
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
    await db.update(submissions).set({ active_attempt_id: id }).where(
      eq(submissions.id, input.source.id),
    );
  } else {
    await db.update(objectiveSubmissions).set({ active_attempt_id: id }).where(
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

/** 把尝试标记为过时（真正超时且已创建新执行时使用）。 */
export async function supersedeAttempt(
  attemptId: string,
  executor?: Executor,
): Promise<void> {
  const db = executor ?? getDb();
  await db.update(evaluationAttempts).set({
    state: "superseded",
    finished_at: new Date().toISOString(),
  }).where(
    and(
      eq(evaluationAttempts.id, attemptId),
      sql`${evaluationAttempts.state} NOT IN ('finished', 'error', 'superseded')`,
    ),
  );
}
