/**
 * 后台任务仓库（P4）。
 *
 * 所有状态迁移都以「token + 状态 + DB 时间」为条件，影响 0 行即视为租约已失效。
 * 领取使用 `FOR UPDATE SKIP LOCKED`，可回收过期租约；并发 worker 不会拿到同一条任务。
 *
 * 事务边界：
 * - `enqueueTaskTx` 必须由业务事务调用（提交、attempt 与派发任务同时提交）；
 * - `completeTaskTx` / `failTaskTx` 也接收真实 `DbTx`，便于把"处理结果"与
 *   业务事实一起提交；
 * - 领取与续租是运行时操作，使用根连接（`claimTasks` / `renewTaskLease`）。
 */
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { DbRoot, DbTx } from "../../../shared/db/executor.ts";
import {
  type BackgroundTaskRow,
  backgroundTasks,
} from "../../../shared/db/schema.ts";
import {
  type ClaimedTask,
  type EnqueueTaskInput,
  type EnqueueTaskResult,
  TASK_DEFAULT_CLAIM_LIMIT,
  TASK_DEFAULT_LEASE_MS,
  TASK_MAX_FAILURES,
  type TaskHealth,
  type TaskPayload,
  type TaskRescheduleResult,
  type TaskType,
} from "./contracts.ts";
import { computeRetryDecision } from "./retry-policy.ts";

/** 生成新的任务 ID（UUID v4）。 */
function newTaskId(): string {
  return crypto.randomUUID();
}

/** 把数据库时间读成毫秒时间戳；所有租约判断都用 DB 时间，避免时钟漂移。 */
async function databaseNowMs(db: DbRoot | DbTx): Promise<number> {
  const rows = await db.execute(sql`SELECT (now() AT TIME ZONE 'UTC') AS now`);
  const result = (rows as unknown as { now?: string }[])[0];
  if (!result?.now) throw new Error("无法读取数据库时间");
  return new Date(`${result.now}Z`).getTime();
}

/**
 * 在业务事务内登记一条任务。
 *
 * 同「类型 + 目标 + 去重键」已存在时返回既有任务 id，且 `created: false`——
 * 不会重复登记，也不会覆盖既有任务的 payload 或状态。
 */
export async function enqueueTaskTx(
  tx: DbTx,
  input: EnqueueTaskInput,
): Promise<EnqueueTaskResult> {
  const nowMs = await databaseNowMs(tx);
  const now = new Date(nowMs).toISOString();
  const availableAt = input.availableAt ?? now;
  if (Number.isNaN(Date.parse(availableAt))) {
    throw new RangeError("任务可领取时刻必须是 ISO 8601 时间");
  }
  const dedupeKey = input.dedupeKey ?? "";
  const rows = await tx.insert(backgroundTasks).values({
    id: newTaskId(),
    task_type: input.taskType,
    target_kind: input.targetKind,
    target_id: input.targetId,
    dedupe_key: dedupeKey,
    payload_version: input.payloadVersion ?? 1,
    payload: input.payload ?? {},
    status: "pending",
    available_at: availableAt,
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing({
    target: [
      backgroundTasks.task_type,
      backgroundTasks.target_kind,
      backgroundTasks.target_id,
      backgroundTasks.dedupe_key,
    ],
  }).returning({ id: backgroundTasks.id });
  if (rows.length > 0) return { taskId: rows[0].id, created: true };

  // 命中既有任务：返回它的 id，让调用方知道"这条事实已经有任务在跑"。
  const [existing] = await tx.select({ id: backgroundTasks.id }).from(
    backgroundTasks,
  ).where(and(
    eq(backgroundTasks.task_type, input.taskType),
    eq(backgroundTasks.target_kind, input.targetKind),
    eq(backgroundTasks.target_id, input.targetId),
    eq(backgroundTasks.dedupe_key, dedupeKey),
  )).limit(1);
  if (!existing) throw new Error("任务去重键命中但既有任务不可见");
  return { taskId: existing.id, created: false };
}

/**
 * 原子领取任务：`FOR UPDATE SKIP LOCKED`，可回收过期租约。
 *
 * 过期租约先回到 `pending`（并保留失败计数），随后与普通 pending 一起参与领取；
 * 租约过期本身也算一次失败，避免"反复崩溃但永不进入 failed"。
 */
export async function claimTasks(
  workerId: string,
  limit = TASK_DEFAULT_CLAIM_LIMIT,
  leaseDurationMs = TASK_DEFAULT_LEASE_MS,
  db: DbRoot = getDb(),
): Promise<ClaimedTask[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("领取数量必须是正整数");
  }
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new RangeError("租约时长必须是正整数毫秒");
  }
  const nowMs = await databaseNowMs(db);
  const now = new Date(nowMs).toISOString();
  const leaseExpiry = new Date(nowMs + leaseDurationMs).toISOString();

  return await db.transaction(async (tx) => {
    // 回收过期租约：计数一次失败，达到上限直接终态失败。
    await tx.update(backgroundTasks).set({
      status:
        sql`CASE WHEN ${backgroundTasks.failure_count} + 1 >= ${TASK_MAX_FAILURES} THEN 'failed' ELSE 'pending' END`,
      failure_count: sql`${backgroundTasks.failure_count} + 1`,
      lease_token: null,
      lease_owner: null,
      lease_expiry: null,
      last_error: "租约过期，任务被回收",
      updated_at: now,
      finished_at:
        sql`CASE WHEN ${backgroundTasks.failure_count} + 1 >= ${TASK_MAX_FAILURES} THEN ${now} ELSE ${backgroundTasks.finished_at} END`,
    }).where(and(
      eq(backgroundTasks.status, "leased"),
      lte(backgroundTasks.lease_expiry, now),
    ));

    const candidates = await tx.select({ id: backgroundTasks.id }).from(
      backgroundTasks,
    ).where(and(
      eq(backgroundTasks.status, "pending"),
      lte(backgroundTasks.available_at, now),
    )).orderBy(asc(backgroundTasks.available_at), asc(backgroundTasks.id))
      .limit(limit).for("update", { skipLocked: true });

    if (candidates.length === 0) return [];
    const ids = candidates.map((row) => row.id);
    const tokens = new Map<string, string>();
    for (const id of ids) tokens.set(id, crypto.randomUUID());

    // 逐条写入独立 token：用 CASE 一次性写回，避免 N 次 UPDATE。
    const tokenCase = sql.join(
      ids.map((id) => sql`WHEN ${id} THEN ${tokens.get(id)!}`),
      sql` `,
    );
    const updated = await tx.update(backgroundTasks).set({
      status: "leased",
      lease_token: sql`CASE ${backgroundTasks.id} ${tokenCase} END`,
      lease_owner: workerId,
      lease_expiry: leaseExpiry,
      updated_at: now,
    }).where(inArray(backgroundTasks.id, ids)).returning();

    const byId = new Map(updated.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      if (!row || !row.lease_token) return [];
      return [{
        id: row.id,
        taskType: row.task_type as TaskType,
        targetKind: row.target_kind as ClaimedTask["targetKind"],
        targetId: row.target_id,
        dedupeKey: row.dedupe_key,
        payloadVersion: row.payload_version,
        payload: row.payload as TaskPayload,
        failureCount: row.failure_count,
        leaseToken: row.lease_token,
        leaseExpiry: leaseExpiry,
      }];
    });
  });
}

/**
 * 续租：token、状态与未过期租约三者同时匹配才成功。
 *
 * @returns 新租约到期时刻；失败返回 null（调用方必须停止处理）
 */
export async function renewTaskLease(
  taskId: string,
  token: string,
  leaseDurationMs = TASK_DEFAULT_LEASE_MS,
  db: DbRoot = getDb(),
): Promise<string | null> {
  const nowMs = await databaseNowMs(db);
  const now = new Date(nowMs).toISOString();
  const leaseExpiry = new Date(nowMs + leaseDurationMs).toISOString();
  const rows = await db.update(backgroundTasks).set({
    lease_expiry: leaseExpiry,
    updated_at: now,
  }).where(and(
    eq(backgroundTasks.id, taskId),
    eq(backgroundTasks.status, "leased"),
    eq(backgroundTasks.lease_token, token),
  )).returning({ id: backgroundTasks.id });
  return rows.length > 0 ? leaseExpiry : null;
}

/**
 * 完成任务：仅当前持有人可完成；影响 0 行视为租约已失效。
 *
 * @returns 是否成功标记（false 表示租约已失效，调用方不得删除/提交依赖）
 */
export async function completeTaskTx(
  tx: DbTx,
  taskId: string,
  token: string,
  result: Record<string, unknown> = {},
): Promise<boolean> {
  const now = new Date(await databaseNowMs(tx)).toISOString();
  const rows = await tx.update(backgroundTasks).set({
    status: "succeeded",
    lease_token: null,
    lease_owner: null,
    lease_expiry: null,
    last_result: result,
    last_error: null,
    finished_at: now,
    updated_at: now,
  }).where(and(
    eq(backgroundTasks.id, taskId),
    eq(backgroundTasks.status, "leased"),
    eq(backgroundTasks.lease_token, token),
  )).returning({ id: backgroundTasks.id });
  return rows.length > 0;
}

/**
 * 任务已完成一页但仍需继续：清除当前租约并重新进入 pending。
 *
 * 这不是失败重试，不增加 failure_count；游标已经持久化到业务事实，下一次
 * 领取只需继续读取最新事实。token 不匹配时不允许覆盖其他 worker 的状态。
 */
export async function rescheduleTaskTx(
  tx: DbTx,
  taskId: string,
  token: string,
  result: TaskRescheduleResult,
): Promise<boolean> {
  if (Number.isNaN(Date.parse(result.availableAt))) {
    throw new RangeError("任务重新调度时刻必须是 ISO 8601 时间");
  }
  const now = new Date(await databaseNowMs(tx)).toISOString();
  const rows = await tx.update(backgroundTasks).set({
    status: "pending",
    payload: result.payload,
    available_at: result.availableAt,
    failure_count: 0,
    lease_token: null,
    lease_owner: null,
    lease_expiry: null,
    last_result: { rescheduled: true },
    last_error: null,
    finished_at: null,
    updated_at: now,
  }).where(and(
    eq(backgroundTasks.id, taskId),
    eq(backgroundTasks.status, "leased"),
    eq(backgroundTasks.lease_token, token),
  )).returning({ id: backgroundTasks.id });
  return rows.length > 0;
}

/**
 * 失败任务：增加失败次数、安排指数退避；达到 20 次转终态 failed。
 *
 * 租约已失效（token 不匹配）时返回 `false`，不修改任何行。
 */
export async function failTaskTx(
  tx: DbTx,
  taskId: string,
  token: string,
  error: string,
): Promise<{ recorded: boolean; terminal: boolean }> {
  const nowMs = await databaseNowMs(tx);
  const now = new Date(nowMs).toISOString();
  const [current] = await tx.select({
    failureCount: backgroundTasks.failure_count,
  }).from(backgroundTasks).where(and(
    eq(backgroundTasks.id, taskId),
    eq(backgroundTasks.status, "leased"),
    eq(backgroundTasks.lease_token, token),
  )).for("update");
  if (!current) return { recorded: false, terminal: false };

  const nextFailureCount = current.failureCount + 1;
  const decision = computeRetryDecision(nextFailureCount, nowMs);
  const rows = await tx.update(backgroundTasks).set({
    status: decision.terminal ? "failed" : "pending",
    failure_count: nextFailureCount,
    lease_token: null,
    lease_owner: null,
    lease_expiry: null,
    available_at: new Date(decision.availableAtMs).toISOString(),
    last_error: error.slice(0, 2000),
    finished_at: decision.terminal ? now : null,
    updated_at: now,
  }).where(and(
    eq(backgroundTasks.id, taskId),
    eq(backgroundTasks.status, "leased"),
    eq(backgroundTasks.lease_token, token),
  )).returning({ id: backgroundTasks.id });
  return { recorded: rows.length > 0, terminal: decision.terminal };
}

/**
 * 管理员重试终态失败任务：只处理 `failed`，不抢占有效租约。
 *
 * @returns 是否重新入队（false 表示任务不是终态失败）
 */
export async function requeueFailedTaskTx(
  tx: DbTx,
  taskId: string,
): Promise<boolean> {
  const now = new Date(await databaseNowMs(tx)).toISOString();
  const rows = await tx.update(backgroundTasks).set({
    status: "pending",
    failure_count: 0,
    lease_token: null,
    lease_owner: null,
    lease_expiry: null,
    available_at: now,
    last_error: null,
    finished_at: null,
    updated_at: now,
  }).where(and(
    eq(backgroundTasks.id, taskId),
    eq(backgroundTasks.status, "failed"),
  )).returning({ id: backgroundTasks.id });
  return rows.length > 0;
}

/** 读取任务健康快照；供指标与运维查询。 */
export async function readTaskHealth(
  db: DbRoot = getDb(),
): Promise<TaskHealth> {
  const nowMs = await databaseNowMs(db);
  const now = new Date(nowMs).toISOString();
  const [ready] = await db.select({
    count: sql<number>`count(*)::int`,
    oldest: sql<string | null>`min(${backgroundTasks.available_at})`,
  }).from(backgroundTasks).where(and(
    eq(backgroundTasks.status, "pending"),
    lte(backgroundTasks.available_at, now),
  ));
  const [leased] = await db.select({
    count: sql<number>`count(*)::int`,
    oldest: sql<string | null>`min(${backgroundTasks.created_at})`,
    next: sql<string | null>`min(${backgroundTasks.lease_expiry})`,
  }).from(backgroundTasks).where(eq(backgroundTasks.status, "leased"));
  const [failed] = await db.select({
    count: sql<number>`count(*)::int`,
  }).from(backgroundTasks).where(eq(backgroundTasks.status, "failed"));

  const oldestReadyAgeMs = ready?.oldest
    ? Math.max(0, nowMs - Date.parse(ready.oldest))
    : 0;
  const oldestLeasedAgeMs = leased?.oldest
    ? Math.max(0, nowMs - Date.parse(leased.oldest))
    : 0;
  const nextLeaseExpiryMs = leased?.next
    ? Math.max(0, Date.parse(leased.next) - nowMs)
    : 0;
  return {
    ready: ready?.count ?? 0,
    leased: leased?.count ?? 0,
    failed: failed?.count ?? 0,
    oldestReadyAgeMs,
    oldestLeasedAgeMs,
    nextLeaseExpiryMs,
  };
}

/** 按 ID 读取任务行（管理端只读查询）。 */
export async function getTaskById(
  taskId: string,
  db: DbRoot = getDb(),
): Promise<BackgroundTaskRow | null> {
  const [row] = await db.select().from(backgroundTasks).where(
    eq(backgroundTasks.id, taskId),
  ).limit(1);
  return row ?? null;
}

/** 列出任务（管理端分页；按创建时间倒序）。 */
export async function listTasks(
  options: {
    status?: BackgroundTaskRow["status"];
    taskType?: string;
    limit?: number;
    offset?: number;
  } = {},
  db: DbRoot = getDb(),
): Promise<{ data: BackgroundTaskRow[]; total: number }> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);
  const where = and(
    options.status ? eq(backgroundTasks.status, options.status) : undefined,
    options.taskType
      ? eq(backgroundTasks.task_type, options.taskType)
      : undefined,
  );
  const [total] = await db.select({ count: sql<number>`count(*)::int` }).from(
    backgroundTasks,
  ).where(where);
  const data = await db.select().from(backgroundTasks).where(where).orderBy(
    sql`${backgroundTasks.created_at} DESC`,
  ).limit(limit).offset(offset);
  return { data, total: total?.count ?? 0 };
}

/** 判断某任务是否仍在租约中（供 handler 快速自检）。 */
export function isLeaseActive(
  leaseExpiry: string,
  nowMs: number,
): boolean {
  return Date.parse(leaseExpiry) > nowMs;
}

/** 构造一个可领取但尚未租出的任务（测试与运维脚本使用）。 */
export async function insertPendingTask(
  db: DbRoot,
  input: EnqueueTaskInput & { id?: string; failureCount?: number },
): Promise<string> {
  const nowMs = await databaseNowMs(db);
  const now = new Date(nowMs).toISOString();
  const id = input.id ?? newTaskId();
  await db.insert(backgroundTasks).values({
    id,
    task_type: input.taskType,
    target_kind: input.targetKind,
    target_id: input.targetId,
    dedupe_key: input.dedupeKey ?? "",
    payload_version: input.payloadVersion ?? 1,
    payload: input.payload ?? {},
    status: "pending",
    available_at: input.availableAt ?? now,
    failure_count: input.failureCount ?? 0,
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing();
  return id;
}

/** 只在测试里使用的清理入口；生产不得调用。 */
export async function _resetBackgroundTasksForTest(
  db: DbRoot = getDb(),
): Promise<void> {
  await db.delete(backgroundTasks);
}
