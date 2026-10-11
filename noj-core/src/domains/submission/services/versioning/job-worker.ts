/**
 * 批任务 worker 的领取、租约与终态（Handbook §5.7）。
 *
 * 设计要点：
 * - **领取使用独立短事务**：`FOR UPDATE SKIP LOCKED` 领取后立即提交，
 *   业务事务（建尝试、派发）在锁外执行，绝不持锁等待外部 IO；
 * - **lease 60 秒**，执行期间续租；崩溃后 lease 到期可被重新领取；
 * - 网络派发失败按 1/2/4/8/16 秒指数退避，超过 5 次标记条目 `failed`；
 * - 队列容量不足属于**可等待**情况：重新排队但不计作派发失败（`requeueJobItem`）；
 * - 条目终态写入是**幂等**的：已是终态的行不会被覆盖（防止重复派发把
 *   `succeeded` 改回 `dispatched`）；
 * - 全部条目终态后由 `refreshJobStatus` 推导任务状态（无进程内计数器）。
 */

import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  evaluationAttempts,
  llmTokenRevocations,
  submissionJobItems,
  submissionJobs,
} from "../../../../shared/db/schema.ts";
import type { SubmissionJobItemStatus } from "../../../../shared/versioning/types.ts";
import { getRedis } from "../../../../shared/mq/connection.ts";
import { refreshJobStatus } from "./rejudge-jobs.ts";
import { lockProjectionHosts, lockProjectionSource } from "./projection.ts";
import { applyAttemptResult } from "./result-write.ts";
import { runAttemptTerminalRevocationAfterCommit } from "./attempts.ts";

/** 默认 lease 时长（秒）。 */
export const JOB_ITEM_LEASE_SECONDS = 60;
/** 单次领取上限。 */
export const JOB_ITEM_CLAIM_LIMIT = 100;
/** 网络派发失败的最大重试次数与退避序列（秒）。 */
export const DISPATCH_BACKOFF_SECONDS = [1, 2, 4, 8, 16] as const;

/** 领取到的条目。 */
export interface ClaimedJobItem {
  id: string;
  job_id: string;
  ordinal: number;
  source_kind: "submission" | "objective";
  source_id: string;
  problem_id: string;
  target_version_id: string | null;
  target_version_ref: string | null;
  dispatch_retries: number;
  attempt_id: string | null;
  result_submission_id: string | null;
}

/** 条目终态。 */
export type JobItemTerminalStatus = "succeeded" | "failed" | "skipped";

function nowIso(): string {
  return new Date().toISOString();
}

function plusSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/**
 * 领取一批可派发条目（独立短事务）。
 *
 * 可领取 = `pending` 且到达 `next_dispatch_at`，或 `preparing` 且 lease 已过期
 * （崩溃恢复）。
 */
export async function claimJobItems(
  owner: string,
  options: { limit?: number; leaseSeconds?: number } = {},
): Promise<ClaimedJobItem[]> {
  const db = getDb();
  const limit = Math.min(
    options.limit ?? JOB_ITEM_CLAIM_LIMIT,
    JOB_ITEM_CLAIM_LIMIT,
  );
  const leaseSeconds = options.leaseSeconds ?? JOB_ITEM_LEASE_SECONDS;
  const now = nowIso();

  return await db.transaction(async (tx) => {
    const rows = await tx.select({
      id: submissionJobItems.id,
      job_id: submissionJobItems.job_id,
      ordinal: submissionJobItems.ordinal,
      source_kind: submissionJobItems.source_kind,
      source_id: submissionJobItems.source_id,
      problem_id: submissionJobItems.problem_id,
      target_version_id: submissionJobItems.target_version_id,
      target_version_ref: submissionJobItems.target_version_ref,
      dispatch_retries: submissionJobItems.dispatch_retries,
      attempt_id: submissionJobItems.attempt_id,
      result_submission_id: submissionJobItems.result_submission_id,
    }).from(submissionJobItems).where(
      or(
        and(
          eq(submissionJobItems.status, "pending"),
          or(
            isNull(submissionJobItems.next_dispatch_at),
            lte(submissionJobItems.next_dispatch_at, now),
          ),
        ),
        and(
          eq(submissionJobItems.status, "preparing"),
          lte(submissionJobItems.lease_until, now),
        ),
      ),
    ).orderBy(submissionJobItems.ordinal).limit(limit).for("update", {
      skipLocked: true,
    });

    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    await tx.update(submissionJobItems).set({
      status: "preparing",
      lease_owner: owner,
      lease_until: plusSeconds(leaseSeconds),
    }).where(inArray(submissionJobItems.id, ids));
    return rows as ClaimedJobItem[];
  });
}

/** 续租（执行期间调用；条目已终态时返回 false）。 */
export async function renewJobItemLease(
  itemId: string,
  owner: string,
  leaseSeconds = JOB_ITEM_LEASE_SECONDS,
): Promise<boolean> {
  const db = getDb();
  const rows = await db.update(submissionJobItems).set({
    lease_until: plusSeconds(leaseSeconds),
  }).where(
    and(
      eq(submissionJobItems.id, itemId),
      eq(submissionJobItems.lease_owner, owner),
      eq(submissionJobItems.status, "preparing"),
      gt(submissionJobItems.lease_until, nowIso()),
    ),
  ).returning({ id: submissionJobItems.id });
  return rows.length > 0;
}

/**
 * 心跳续租间隔：取 lease 时长的 1/3，保证长 IO 执行期间 lease 不会到期
 * （否则另一个 worker 会重新领取同一条目并重复创建副作用）。
 */
export const JOB_ITEM_LEASE_HEARTBEAT_MS = Math.floor(
  (JOB_ITEM_LEASE_SECONDS * 1000) / 3,
);

/** 续租心跳句柄。 */
export interface JobItemLeaseHeartbeat {
  /** 停止续租（必须在 `finally` 中调用；不会抛错）。 */
  stop(): void;
  /** 是否观察到一次续租失败（租约已丢失/条目已终态）。 */
  lost(): boolean;
}

/**
 * 启动执行期间的持续续租（Handbook §5.7「执行期间续租」）。
 *
 * 单次派发可能包含支持包下载、LLM token 签发与 MQ 推送等长 IO；仅在开始时
 * 续租一次会让 lease 在中途过期，第二个 worker 就会重复领取。这里按
 * `JOB_ITEM_LEASE_HEARTBEAT_MS` 周期续租，租约丢失时只记录 `lost` 标志，
 * 真正的写入保护仍由各写函数的 `lease_owner + lease_until` 条件负责。
 */
export function startJobItemLeaseHeartbeat(
  itemId: string,
  owner: string,
  intervalMs = JOB_ITEM_LEASE_HEARTBEAT_MS,
): JobItemLeaseHeartbeat {
  let stopped = false;
  let lostLease = false;
  const timer = setInterval(() => {
    void renewJobItemLease(itemId, owner).then((renewed) => {
      if (!renewed) lostLease = true;
    }).catch(() => {
      lostLease = true;
    });
  }, intervalMs);
  // 心跳不能阻止进程退出（关闭流程会显式 stop）。
  try {
    Deno.unrefTimer(timer);
  } catch {
    // 非 Deno 运行时不支持 unref：忽略，stop() 仍会清理。
  }
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    lost() {
      return lostLease;
    },
  };
}

/**
 * 标记条目已派发（条件更新）。
 *
 * **只在 `preparing` 时生效**：结果可能比这次状态更新更早到达并把条目写成
 * `succeeded`，此时不能把终态改回 `dispatched`。
 */
export async function markJobItemDispatched(
  itemId: string,
  attemptId: string,
  owner: string,
): Promise<boolean> {
  return await getDb().transaction(async (db) => {
    const rows = await db.update(submissionJobItems).set({
      status: "dispatched",
      attempt_id: attemptId,
      lease_owner: null,
      lease_until: null,
    }).where(
      and(
        eq(submissionJobItems.id, itemId),
        eq(submissionJobItems.status, "preparing"),
        eq(submissionJobItems.lease_owner, owner),
        gt(submissionJobItems.lease_until, nowIso()),
      ),
    ).returning({ id: submissionJobItems.id });
    if (rows.length === 0) return false;
    await touchJobStatus(itemId, db);
    return true;
  });
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

/** 事务内收集到的待吊销目标（提交后执行）。 */
interface PendingRevocation {
  attemptId: string;
  submissionId: string | null;
  taskSnapshot: unknown;
}

/** 尝试终态事务的返回值：是否写入 + 提交后需要吊销的尝试。 */
interface JobItemTerminalWrite {
  ok: boolean;
  revoked?: PendingRevocation;
}

/**
 * 写条目终态（幂等）。
 *
 * 已是终态（succeeded/failed/skipped）的行不再被覆盖——相同尝试允许重复派发，
 * 但结果只应用一次。
 */
export async function completeJobItem(
  itemId: string,
  terminal: {
    status: JobItemTerminalStatus;
    attemptId?: string | null;
    reasonCode?: string | null;
    reasonMessage?: string | null;
    /** worker 写终态必须提供租约所有者；可信结果回写不依赖派发租约。 */
    leaseOwner?: string;
  },
  executor?: Executor,
): Promise<boolean> {
  if (executor) {
    // 调用方持有事务：吊销必须由调用方在**提交之后**执行（见 revokeAttemptLlmTokens）
    return (await completeJobItemInTx(itemId, terminal, executor)).ok;
  }
  const written = await getDb().transaction((tx) =>
    completeJobItemInTx(itemId, terminal, tx)
  );
  // 提交后立即执行 outbox 吊销；失败保留 pending，由后台消费者重试（复审问题 2）
  if (written.revoked) {
    await runAttemptTerminalRevocationAfterCommit(written.revoked.attemptId);
  }
  return written.ok;
}

/** `completeJobItem` 的事务内实现：返回待吊销目标供提交后处理。 */
async function completeJobItemInTx(
  itemId: string,
  terminal: {
    status: JobItemTerminalStatus;
    attemptId?: string | null;
    reasonCode?: string | null;
    reasonMessage?: string | null;
    leaseOwner?: string;
  },
  db: Executor,
): Promise<JobItemTerminalWrite> {
  if (terminal.status === "failed" && terminal.leaseOwner) {
    const [identity] = await db.select().from(submissionJobItems).where(
      eq(submissionJobItems.id, itemId),
    );
    const [attempt] = identity?.attempt_id
      ? await db.select().from(evaluationAttempts).where(
        eq(evaluationAttempts.id, identity.attempt_id),
      )
      : [];
    if (attempt) {
      await lockProjectionHosts(db, {
        kind: attempt.submission_id ? "submission" : "objective",
        id: (attempt.submission_id ?? attempt.objective_submission_id)!,
        problem_id: attempt.problem_id,
      });
      await lockProjectionSource(db, {
        kind: attempt.submission_id ? "submission" : "objective",
        id: (attempt.submission_id ?? attempt.objective_submission_id)!,
        problem_id: attempt.problem_id,
      });
      const [current] = await db.select().from(submissionJobItems).where(
        eq(submissionJobItems.id, itemId),
      ).for("update");
      if (
        !current || current.status !== "preparing" ||
        current.lease_owner !== terminal.leaseOwner || !current.lease_until ||
        current.lease_until <= nowIso()
      ) return { ok: false };
      const applied = await applyAttemptResult({
        attemptId: attempt.id,
        resultKind: "platform_error",
        resultStatus: terminal.reasonCode ?? "DISPATCH_FAILED",
        score: null,
        accepted: false,
        output: terminal.reasonMessage ?? "批任务执行失败",
      }, db);
      if (applied.applied !== "ignored") {
        // 结果写入已把条目置为 failed（并清空源活动指针、保留历史判定）；
        // 这里把派发阶段的**具体原因码**补写回条目，避免只留通用 PLATFORM_ERROR。
        await db.update(submissionJobItems).set({
          reason_code: terminal.reasonCode ?? "PLATFORM_ERROR",
          reason_message: terminal.reasonMessage ?? null,
          next_dispatch_at: null,
          lease_owner: null,
          lease_until: null,
        }).where(eq(submissionJobItems.id, itemId));
        return {
          ok: true,
          revoked: {
            attemptId: attempt.id,
            submissionId: attempt.submission_id ??
              attempt.objective_submission_id,
            taskSnapshot: attempt.task_snapshot,
          },
        };
      }
    }
  }
  const rows = await db.update(submissionJobItems).set({
    status: terminal.status,
    ...(terminal.attemptId !== undefined
      ? { attempt_id: terminal.attemptId }
      : {}),
    reason_code: terminal.reasonCode ?? null,
    reason_message: terminal.reasonMessage ?? null,
    lease_owner: null,
    lease_until: null,
    next_dispatch_at: null,
    finished_at: nowIso(),
  }).where(
    and(
      eq(submissionJobItems.id, itemId),
      sql`${submissionJobItems.status} NOT IN ('succeeded', 'failed', 'skipped')`,
      ...(terminal.leaseOwner
        ? [
          eq(submissionJobItems.status, "preparing"),
          eq(submissionJobItems.lease_owner, terminal.leaseOwner),
          gt(submissionJobItems.lease_until, nowIso()),
        ]
        : []),
    ),
  ).returning({ id: submissionJobItems.id });
  if (rows.length === 0) return { ok: false };
  await touchJobStatus(itemId, db);
  return { ok: true };
}

/** 依据条目 id 找到任务并刷新其聚合状态。 */
async function touchJobStatus(
  itemId: string,
  executor: Executor,
): Promise<void> {
  const [row] = await executor.select({ job_id: submissionJobItems.job_id })
    .from(submissionJobItems).where(eq(submissionJobItems.id, itemId)).limit(1);
  if (row) await refreshJobStatus(row.job_id, executor);
}

/**
 * 派发失败处理：未超过退避序列则重新排队，超过则条目 `failed`。
 *
 * @returns `true` 表示已重新排队（可重试），`false` 表示已标记失败
 */
export async function scheduleDispatchRetryOrFail(
  itemId: string,
  options: { reasonCode: string; reasonMessage: string; leaseOwner?: string },
): Promise<boolean> {
  const written = await getDb().transaction(async (db): Promise<
    JobItemTerminalWrite
  > => {
    // 与结果落库遵循同一锁序：策略宿主 → 提交 → 条目 → 任务。
    const [identity] = await db.select().from(submissionJobItems).where(
      eq(submissionJobItems.id, itemId),
    );
    const [attempt] = identity?.attempt_id
      ? await db.select().from(evaluationAttempts).where(
        eq(evaluationAttempts.id, identity.attempt_id),
      )
      : [];
    if (attempt) {
      await lockProjectionHosts(db, {
        kind: attempt.submission_id ? "submission" : "objective",
        id: (attempt.submission_id ?? attempt.objective_submission_id)!,
        problem_id: attempt.problem_id,
      });
      await lockProjectionSource(db, {
        kind: attempt.submission_id ? "submission" : "objective",
        id: (attempt.submission_id ?? attempt.objective_submission_id)!,
        problem_id: attempt.problem_id,
      });
    }
    const [item] = await db.select().from(submissionJobItems).where(
      eq(submissionJobItems.id, itemId),
    ).for("update");
    if (
      !item || ["succeeded", "failed", "skipped"].includes(item.status) ||
      (options.leaseOwner &&
        (item.status !== "preparing" ||
          item.lease_owner !== options.leaseOwner || !item.lease_until ||
          item.lease_until <= nowIso()))
    ) return { ok: false };
    const retries = item.dispatch_retries;
    if (retries >= DISPATCH_BACKOFF_SECONDS.length) {
      if (attempt) {
        await applyAttemptResult({
          attemptId: attempt.id,
          resultKind: "platform_error",
          resultStatus: "DISPATCH_FAILED",
          score: null,
          accepted: false,
          output: options.reasonMessage,
        }, db);
      }
      await completeJobItem(itemId, {
        status: "failed",
        reasonCode: options.reasonCode,
        reasonMessage: options.reasonMessage,
      }, db);
      // `applyAttemptResult` 已把条目写成 `failed` + 通用 `PLATFORM_ERROR`，
      // 此时上面的终态写入是幂等跳过（0 行）。这里补写派发阶段的**具体原因码**，
      // 但只限 `failed` 行——绝不覆盖 succeeded/skipped。
      await db.update(submissionJobItems).set({
        reason_code: options.reasonCode,
        reason_message: options.reasonMessage,
      }).where(
        and(
          eq(submissionJobItems.id, itemId),
          eq(submissionJobItems.status, "failed"),
        ),
      );
      // `applyAttemptResult` 在 `finishAttempt` 内与终态同事务登记吊销 outbox。
      return {
        ok: false,
        revoked: attempt
          ? {
            attemptId: attempt.id,
            submissionId: attempt.submission_id ??
              attempt.objective_submission_id,
            taskSnapshot: attempt.task_snapshot,
          }
          : undefined,
      };
    }
    const backoff = DISPATCH_BACKOFF_SECONDS[retries];
    await db.update(submissionJobItems).set({
      status: "pending",
      dispatch_retries: retries + 1,
      next_dispatch_at: plusSeconds(backoff),
      lease_owner: null,
      lease_until: null,
    }).where(
      and(
        eq(submissionJobItems.id, itemId),
        sql`${submissionJobItems.status} NOT IN ('succeeded', 'failed', 'skipped')`,
      ),
    );
    return { ok: true };
  });
  // 事务提交后才执行吊销：避免回滚后留下"仍在跑却被吊销"的尝试；
  // 失败保留 outbox pending，由后台消费者重试（复审问题 2）
  if (written.revoked) {
    await runAttemptTerminalRevocationAfterCommit(written.revoked.attemptId);
  }
  return written.ok;
}

/**
 * 队列容量不足时的重新排队：**不计作派发失败**（不退避计数）。
 */
export async function requeueJobItem(
  itemId: string,
  delaySeconds = 5,
  owner?: string,
): Promise<void> {
  const db = getDb();
  await db.update(submissionJobItems).set({
    status: "pending",
    next_dispatch_at: plusSeconds(delaySeconds),
    lease_owner: null,
    lease_until: null,
  }).where(
    and(
      eq(submissionJobItems.id, itemId),
      sql`${submissionJobItems.status} NOT IN ('succeeded', 'failed', 'skipped')`,
      ...(owner
        ? [
          eq(submissionJobItems.status, "preparing"),
          eq(submissionJobItems.lease_owner, owner),
          gt(submissionJobItems.lease_until, nowIso()),
        ]
        : []),
    ),
  );
}

/** 回收过期 lease（崩溃恢复）：`preparing` 且 lease 过期 → 回到 `pending`。 */
export async function requeueExpiredLeases(
  executor?: Executor,
): Promise<number> {
  const db = executor ?? getDb();
  const rows = await db.update(submissionJobItems).set({
    status: "pending",
    lease_owner: null,
    lease_until: null,
  }).where(
    and(
      eq(submissionJobItems.status, "preparing"),
      lte(submissionJobItems.lease_until, nowIso()),
    ),
  ).returning({ id: submissionJobItems.id, job_id: submissionJobItems.job_id });
  for (const jobId of new Set(rows.map((row) => row.job_id))) {
    await refreshJobStatus(jobId, db);
  }
  return rows.length;
}

/** 读取任务的活动条目（`preparing`/`dispatched`），用于观测与断言。 */
export async function listActiveJobItems(
  jobId: string,
  executor?: Executor,
): Promise<
  Array<
    { id: string; status: SubmissionJobItemStatus; attempt_id: string | null }
  >
> {
  const db = executor ?? getDb();
  return await db.select({
    id: submissionJobItems.id,
    status: submissionJobItems.status,
    attempt_id: submissionJobItems.attempt_id,
  }).from(submissionJobItems).where(
    and(
      eq(submissionJobItems.job_id, jobId),
      inArray(
        submissionJobItems.status,
        ["preparing", "dispatched"] as SubmissionJobItemStatus[],
      ),
    ),
  );
}

/** 任务是否仍可继续（存在未终态条目）。 */
export async function hasOpenJobItems(
  jobId: string,
  executor?: Executor,
): Promise<boolean> {
  const db = executor ?? getDb();
  const [row] = await db.select({ id: submissionJobItems.id })
    .from(submissionJobItems).where(
      and(
        eq(submissionJobItems.job_id, jobId),
        inArray(
          submissionJobItems.status,
          ["pending", "preparing", "dispatched"] as SubmissionJobItemStatus[],
        ),
      ),
    ).limit(1);
  return Boolean(row);
}

/** 批任务条目的**未终态**状态集合。 */
export const OPEN_JOB_ITEM_STATUSES = [
  "pending",
  "preparing",
  "dispatched",
] as const;

/** 源提交引用（两类统一）。 */
export interface JobItemSourceRef {
  kind: "submission" | "objective";
  id: string;
}

/** 结算门禁读模型（§4.3、#46）。 */
export interface OpenJobItemView {
  job_id: string;
  item_id: string;
  status: string;
  source_kind: "submission" | "objective";
  source_id: string;
  problem_id: string;
  target_version_id: string | null;
  target_version_ref: string | null;
}

/**
 * 查询一组源提交上**尚未进入终态**的批任务条目（供竞赛结算门禁使用，§4.3/#46）。
 *
 * 关键点：条目在**受理事务内**即落库（`pending`，此时可能还没有 `attempt_id`），
 * 因此 `queued` / `preparing` 阶段「尚未创建尝试」的批任务同样会被查到——
 * 正式成绩发布必须在同一一致性事务里发现这类任务并拒绝发布快照。
 *
 * @param sources 源提交集合（`kind` + 原始 id）；空集合直接返回空
 * @param executor 结算事务的执行器，保证与结算读取同一快照
 */
export async function listOpenJobItemsForSources(
  sources: readonly JobItemSourceRef[],
  executor?: Executor,
): Promise<OpenJobItemView[]> {
  const db = executor ?? getDb();
  const plain = [
    ...new Set(
      sources.filter((source) => source.kind === "submission").map((source) =>
        source.id
      ),
    ),
  ];
  const objective = [
    ...new Set(
      sources.filter((source) => source.kind === "objective").map((source) =>
        source.id
      ),
    ),
  ];
  const scopes = [];
  if (plain.length > 0) {
    scopes.push(
      and(
        eq(submissionJobItems.source_kind, "submission"),
        inArray(submissionJobItems.source_id, plain),
      ),
    );
  }
  if (objective.length > 0) {
    scopes.push(
      and(
        eq(submissionJobItems.source_kind, "objective"),
        inArray(submissionJobItems.source_id, objective),
      ),
    );
  }
  if (scopes.length === 0) return [];
  const rows = await db.select({
    job_id: submissionJobItems.job_id,
    item_id: submissionJobItems.id,
    status: submissionJobItems.status,
    source_kind: submissionJobItems.source_kind,
    source_id: submissionJobItems.source_id,
    problem_id: submissionJobItems.problem_id,
    target_version_id: submissionJobItems.target_version_id,
    target_version_ref: submissionJobItems.target_version_ref,
  }).from(submissionJobItems).where(
    and(
      scopes.length === 1 ? scopes[0] : or(...scopes),
      inArray(
        submissionJobItems.status,
        OPEN_JOB_ITEM_STATUSES as unknown as SubmissionJobItemStatus[],
      ),
    ),
  ).orderBy(submissionJobItems.job_id, submissionJobItems.ordinal);
  return rows;
}

/** 便捷布尔版：给定源提交上是否存在未终态批任务条目。 */
export async function hasOpenJobItemsForSources(
  sources: readonly JobItemSourceRef[],
  executor?: Executor,
): Promise<boolean> {
  return (await listOpenJobItemsForSources(sources, executor)).length > 0;
}

/** 读取任务行（幂等键校验等场景）。 */
export async function findJobById(jobId: string) {
  const db = getDb();
  const [row] = await db.select().from(submissionJobs).where(
    eq(submissionJobs.id, jobId),
  ).limit(1);
  return row ?? null;
}
