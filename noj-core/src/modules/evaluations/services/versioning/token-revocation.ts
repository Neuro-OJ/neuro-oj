/**
 * 评测尝试终态的 LLM eval_token 吊销与 outbox。
 *
 * 这是 attempts/result-write/job-worker 共用的叶子模块，避免生命周期、
 * 结果写入与 worker 彼此形成运行时循环。
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  evaluationAttempts,
  llmTokenRevocations,
} from "../../../../shared/db/schema.ts";
import { getRedis } from "../../../../shared/mq/connection.ts";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * LLM eval_token 吊销标记的**最小** TTL（秒）。
 *
 * 即便尝试没有可推导的签发有效期，也不早于 1h 过期。
 */
export const LLM_REVOCATION_MIN_TTL_SECONDS = 3600;
/** 吊销 TTL 余量（秒）：覆盖写入延迟与时钟偏差。 */
export const LLM_REVOCATION_TTL_MARGIN_SECONDS = 300;

/**
 * 从尝试的冻结快照推导本次已签发 eval_token 的 TTL 上界（秒）。
 *
 * 与 gateway 的签发口径保持一致（`gateway/services/llm-token.ts`：
 * `ttl = max(60, ceil(evaluator.time_limit_ms * 4 / 1000))`），再取 1h 下限并加余量。
 *
 * **不能写死 3600**：`judge_max_evaluator_time_limit_ms` 未配置时题目可以声明任意长的
 * `time_limit_ms`，其 token 有效期会远超 1h；吊销标记若先于 token 过期，token 会在尝试
 * 终态之后继续可用。快照缺失时退回 1h 下限。
 */
export function resolveAttemptTokenTtlSeconds(taskSnapshot: unknown): number {
  const runtime =
    (taskSnapshot as { runtime_config?: unknown } | null | undefined)
      ?.runtime_config as
        | { evaluator?: { time_limit_ms?: unknown } }
        | undefined;
  const timeLimitMs = runtime?.evaluator?.time_limit_ms;
  const issuedTtl = typeof timeLimitMs === "number" &&
      Number.isFinite(timeLimitMs) && timeLimitMs > 0
    ? Math.max(60, Math.ceil((timeLimitMs * 4) / 1000))
    : 0;
  return Math.max(LLM_REVOCATION_MIN_TTL_SECONDS, issuedTtl) +
    LLM_REVOCATION_TTL_MARGIN_SECONDS;
}

/** 吊销后处理结果（供测试与日志断言）。 */
export interface AttemptRevocationOutcome {
  /** 是否成功写入 Redis 吊销标记（Redis 不可用/异常时为 false）。 */
  applied: boolean;
  /** 实际写入的标记 TTL（秒）。 */
  ttl_seconds: number;
  attempt_id: string | null;
}

/** 读取尝试的冻结快照（用于推导 token TTL）；尝试不存在或查询失败返回 null。 */
async function loadAttemptTaskSnapshot(
  attemptId: string | null | undefined,
): Promise<unknown> {
  if (!attemptId) return null;
  try {
    const [row] = await getDb().select({
      snapshot: evaluationAttempts.task_snapshot,
    }).from(evaluationAttempts).where(
      eq(evaluationAttempts.id, attemptId),
    ).limit(1);
    return row?.snapshot ?? null;
  } catch {
    return null;
  }
}

/**
 * **统一的尝试终态后处理：吊销该尝试签发的 LLM eval_token**（Handbook §6.7）。
 *
 * 为什么必须是统一入口：吊销此前只写在正常结果入口（`submissions-result.ts`），
 * 而 worker / sweeper 的永久失败、重试耗尽、崩溃恢复失败等路径直接调用
 * `applyAttemptResult()` 终结尝试，**绕过吊销** —— 被判失败的尝试其 token 仍可在
 * 剩余有效期内继续调用 gateway，形成免费的额度绕过。
 *
 * 语义：
 * - 覆盖 `finished` / `error` / `superseded` 等**全部**尝试终态（本函数不区分终态种类）；
 * - 标记 TTL 覆盖该尝试**全部已签发 token 的剩余有效期**（由冻结快照推导 + 余量），
 *   不是固定 3600s；
 * - 幂等：重复调用只是刷新同一批键的 TTL；
 * - **必须在业务事务提交之后调用**：在事务内吊销会在回滚后留下"尝试仍在跑却被吊销"
 *   的错误状态。因此 `completeJobItem` / `scheduleDispatchRetryOrFail` 只在自身事务
 *   提交后调用本函数；持有调用方事务的路径由调用方在提交后自行调用。
 *
 * @param input.attemptId 尝试 ID（= 正式评测 `run_id`）
 * @param input.submissionId 源提交 ID；用于兼容旧协议（无 attempt 维度）的吊销键
 * @param input.taskSnapshot 冻结快照；缺省时按 attemptId 查库
 */
export async function revokeAttemptLlmTokens(input: {
  attemptId: string | null;
  submissionId?: string | null;
  taskSnapshot?: unknown;
}): Promise<AttemptRevocationOutcome> {
  const snapshot = input.taskSnapshot === undefined
    ? await loadAttemptTaskSnapshot(input.attemptId)
    : input.taskSnapshot;
  const ttlSeconds = resolveAttemptTokenTtlSeconds(snapshot);
  const applied = await writeRevocationMarkers({
    attemptId: input.attemptId,
    submissionId: input.submissionId ?? null,
    ttlSeconds,
  });
  return {
    applied,
    ttl_seconds: ttlSeconds,
    attempt_id: input.attemptId,
  };
}

/**
 * 以**显式 TTL** 写吊销标记（幂等）。Redis 不可用/异常时返回 false，不抛错。
 *
 * 显式 TTL 入口供 outbox 补偿使用：补偿必须沿用**登记时冻结的** TTL，而不是
 * 重新推导（快照可能已被替换或清理）。
 */
export async function writeRevocationMarkers(input: {
  attemptId: string | null;
  submissionId?: string | null;
  ttlSeconds: number;
}): Promise<boolean> {
  if (!input.attemptId && !input.submissionId) return false;
  const ttlSeconds = Number.isFinite(input.ttlSeconds) && input.ttlSeconds > 0
    ? Math.floor(input.ttlSeconds)
    : LLM_REVOCATION_MIN_TTL_SECONDS;
  try {
    const redis = getRedis();
    if (redis.status !== "ready") return false;
    if (input.attemptId) {
      await redis.set(
        `llm:attempt:revoked:${input.attemptId}`,
        "1",
        "EX",
        ttlSeconds,
      );
    }
    if (input.submissionId) {
      // 旧协议 token 仅带 submission 维度，继续写旧键保证同样被吊销。
      await redis.set(
        `llm:token:revoked:${input.submissionId}`,
        "1",
        "EX",
        ttlSeconds,
      );
    }
    return true;
  } catch {
    // 吊销失败不能影响已提交的业务终态；由 outbox 补偿与日志兜底观测
    return false;
  }
}

/** 终态吊销 outbox 的行读模型。 */
export interface PendingTokenRevocation {
  id: string;
  attempt_id: string;
  submission_id: string | null;
  ttl_seconds: number;
}

/**
 * 在**写尝试终态的同一数据库事务内**登记一行 pending 吊销 outbox（幂等）。
 *
 * 为什么必须持久化：Redis 不可用时"终态已提交、吊销未执行"不能只靠日志兜底——
 * 重复终结会因尝试已是终态而提前返回，sweeper 也不会再碰它，吊销将被永久遗漏
 * （复审问题 2 实测）。outbox 行由后台消费者重试直到 `done`。
 *
 * 幂等：同一尝试已有 `pending`/`done` 行时直接返回（不重复插入）。
 */
export async function enqueueAttemptTokenRevocation(
  executor: Executor,
  input: {
    attemptId: string;
    submissionId?: string | null;
    /** 登记时冻结的 TTL（覆盖该尝试已签发 token 的剩余有效期）。 */
    ttlSeconds: number;
  },
): Promise<void> {
  const [existing] = await executor.select({ id: llmTokenRevocations.id })
    .from(llmTokenRevocations).where(
      and(
        eq(llmTokenRevocations.attempt_id, input.attemptId),
        inArray(llmTokenRevocations.state, ["pending", "done"]),
      ),
    ).limit(1);
  if (existing) return;
  await executor.insert(llmTokenRevocations).values({
    id: crypto.randomUUID(),
    attempt_id: input.attemptId,
    submission_id: input.submissionId ?? null,
    ttl_seconds: Math.floor(input.ttlSeconds),
    state: "pending",
    attempts: 0,
    created_at: nowIso(),
  });
}

/**
 * 立即执行某个尝试的 outbox 吊销（终态事务提交后调用）。
 *
 * 成功 → 行标记 `done`；失败（Redis 不可用）→ 保留 `pending` 并累加 `attempts`，
 * 交给后台消费者重试。返回是否已完成。
 */
export async function attemptTokenRevocationNow(
  attemptId: string,
): Promise<boolean> {
  const db = getDb();
  const rows = await db.select().from(llmTokenRevocations).where(
    and(
      eq(llmTokenRevocations.attempt_id, attemptId),
      eq(llmTokenRevocations.state, "pending"),
    ),
  );
  if (rows.length === 0) return true;
  let allDone = true;
  for (const row of rows) {
    if (await completeTokenRevocationRow(row)) continue;
    allDone = false;
    await db.update(llmTokenRevocations).set({
      attempts: sql`${llmTokenRevocations.attempts} + 1`,
    }).where(eq(llmTokenRevocations.id, row.id));
  }
  return allDone;
}

/** 执行单行吊销并标记 done（Redis 未成功写入时返回 false）。 */
async function completeTokenRevocationRow(
  row: PendingTokenRevocation,
): Promise<boolean> {
  const applied = await writeRevocationMarkers({
    attemptId: row.attempt_id,
    submissionId: row.submission_id,
    ttlSeconds: row.ttl_seconds,
  });
  if (!applied) return false;
  const rows = await getDb().update(llmTokenRevocations).set({
    state: "done",
    done_at: nowIso(),
    attempts: sql`${llmTokenRevocations.attempts} + 1`,
  }).where(
    and(
      eq(llmTokenRevocations.id, row.id),
      eq(llmTokenRevocations.state, "pending"),
    ),
  ).returning({ id: llmTokenRevocations.id });
  return rows.length > 0;
}

/**
 * 后台补偿：把 pending 吊销推进到 done（Redis 恢复后自动完成）。
 *
 * 由 sweeper 周期与进程启动阶段调用；也可供测试直接驱动。
 * 按 `created_at` 升序处理，单轮上限 `limit`（默认 100）。
 */
export async function runPendingTokenRevocations(
  limit = 100,
): Promise<{ processed: number; completed: number }> {
  const db = getDb();
  const rows = await db.select().from(llmTokenRevocations).where(
    eq(llmTokenRevocations.state, "pending"),
  ).orderBy(asc(llmTokenRevocations.created_at)).limit(Math.max(1, limit));
  let completed = 0;
  for (const row of rows) {
    if (await completeTokenRevocationRow(row)) {
      completed += 1;
      continue;
    }
    await db.update(llmTokenRevocations).set({
      attempts: sql`${llmTokenRevocations.attempts} + 1`,
    }).where(eq(llmTokenRevocations.id, row.id));
  }
  return { processed: rows.length, completed };
}
