import { and, eq, inArray, isNull, not, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { getDb } from "./../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  problems,
  selfTests,
  submissions,
  users,
} from "./../../../shared/db/schema.ts";
import { getRedis } from "./../../../shared/mq/connection.ts";
import {
  ALL_JUDGE_QUEUES,
  JUDGE_POOL_QUEUES,
  JUDGE_QUEUE_LAYOUT,
  JUDGE_QUEUE_PREFIX,
  JUDGE_QUEUES,
  JUDGE_RESOURCE_POOLS,
  type JudgeQueuePool,
} from "../../../shared/mq/judge-queues.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "submission"]);
import { NotFoundError } from "./../../../shared/base/errors.ts";
import { Channels, publishSseEvent } from "./../../../shared/sse/event-bus.ts";
import { logAudit } from "../../system/index.ts";
import { SELF_TEST_ID_PREFIX } from "./../types/self-tests.ts";

/** 评测任务队列名称列表（与 producer.ts 一致，按优先级排列）。 */
const JUDGE_QUEUE_LIST = ALL_JUDGE_QUEUES;

/** 评测结果队列名称（与 consumer.ts 一致）。 */
const RESULT_QUEUE = "noj:judge:results";

/** 监控/列表路径默认只读取的 pending 条目数；超过时为保证正确性回退全量 LRANGE。 */
const PENDING_LIST_LIMIT = 1000;

// ─── 响应类型 ───────────────────────────────────────────────────────

/** 队列中的一个条目（pending / judging / recently_completed 共用）。 */
export interface QueueItem {
  id: string;
  problem_id: string;
  problem_title: string;
  language: string;
  submitted_at: string;
  submitted_by: string;
  /** 条目类型：正式提交或自测。 */
  kind: "submission" | "self_test";
  resource_pool?: JudgeQueuePool;
  waiting_reason?: "pool_full" | "user_busy" | "memory";
  /** 仅 judging 和 completed 项有值。 */
  judge_started_at?: string | null;
  /** 仅 completed 项有值。 */
  judge_finished_at?: string | null;
  /** 仅 completed 项有值。 */
  status?: string;
  /** 仅 completed 项有值（×100 整数值）。 */
  score?: number | null;
}

/** 队列统计信息。 */
export interface QueueStats {
  pending_count: number;
  judging_count: number;
  completed_today: number;
  pools?: Record<
    JudgeQueuePool,
    {
      pending: number;
      processing: number;
      active?: number;
      compiling?: number;
      running?: number;
      task_capacity?: number;
      run_capacity?: number;
    }
  >;
  resource_memory?: { reserved_mb: number; budget_mb: number };
}

/** `GET /api/v1/queue` 完整响应体。 */
export interface QueueResponse {
  pending: QueueItem[];
  judging: QueueItem[];
  recently_completed: QueueItem[];
  stats: QueueStats;
}

/** 单条评测队列的健康快照。 */
export interface QueueHealthEntry {
  /** 主队列当前长度（待 worker 领取）。 */
  queue_length: number;
  /** processing 列表当前长度（已领取但未确认）。 */
  processing_length: number;
  /** dead 死信队列当前长度。 */
  dead_length: number;
}

/** `GET /api/v1/admin/queue/health` 响应体。 */
export interface QueueHealthResponse {
  pools?: Record<JudgeQueuePool, QueueHealthEntry>;
  resource_groups?: Record<string, Record<string, unknown>>;
  /** 评测任务队列（noj-core → noj-judge）。 */
  judge: QueueHealthEntry;
  /** 评测结果队列（noj-judge → noj-core）。 */
  result: QueueHealthEntry;
  /** Redis 是否可用；不可用时各队列长度降级为 -1。 */
  redis_ok: boolean;
}

/** 队列查询所需的表列集合。 */
interface QueueTableColumns {
  id: AnyPgColumn;
  problemId: AnyPgColumn;
  language: AnyPgColumn;
  createdAt: AnyPgColumn;
  userId: AnyPgColumn;
  judgeStartedAt?: AnyPgColumn;
  judgeFinishedAt?: AnyPgColumn;
  status?: AnyPgColumn;
  score?: AnyPgColumn;
}

/**
 * 查询正式提交或自测的队列行，统一 JOIN problems/users（及可选的最近尝试）。
 *
 * `scoreFromAttempt` 给定时，分数取该提交**最近一次终态尝试**（优先
 * `latest_attempt_id`，存量行回退 `effective_attempt_id`）——不再读已停止写入的
 * `evaluation_results`。
 */
async function queryQueueRows(
  table: AnyPgTable,
  cols: QueueTableColumns,
  kind: QueueItem["kind"],
  where: SQL | undefined,
  orderBy?: SQL,
  limit?: number,
  scoreFromAttempt?: { latest: AnyPgColumn; effective: AnyPgColumn },
): Promise<QueueItem[]> {
  const db = getDb();
  const selectFields: Record<string, unknown> = {
    id: cols.id,
    problem_id: cols.problemId,
    problem_title: problems.title,
    language: cols.language,
    submitted_at: cols.createdAt,
    submitted_by: users.username,
  };
  if (cols.judgeStartedAt) selectFields.judge_started_at = cols.judgeStartedAt;
  if (cols.judgeFinishedAt) {
    selectFields.judge_finished_at = cols.judgeFinishedAt;
  }
  if (cols.status) selectFields.status = cols.status;
  if (scoreFromAttempt) {
    selectFields.score = evaluationAttempts.score;
  } else if (cols.score) {
    selectFields.score = cols.score;
  }

  // 动态列集合无法保留 Drizzle 的精确查询类型，这里使用 any 收窄到内部契约。
  // deno-lint-ignore no-explicit-any
  let query: any = db
    // deno-lint-ignore no-explicit-any
    .select(selectFields as any)
    .from(table)
    .innerJoin(problems, eq(cols.problemId, problems.id))
    .innerJoin(users, eq(cols.userId, users.id));
  if (scoreFromAttempt) {
    query = query.leftJoin(
      evaluationAttempts,
      eq(
        evaluationAttempts.id,
        sql`coalesce(${scoreFromAttempt.latest}, ${scoreFromAttempt.effective})`,
      ),
    );
  }
  if (where) query = query.where(where);
  if (orderBy) query = query.orderBy(orderBy);
  if (limit !== undefined) query = query.limit(limit);

  // deno-lint-ignore no-explicit-any
  const rows: any[] = await query;
  return rows.map((r) => {
    const item: QueueItem = {
      id: r.id as string,
      problem_id: r.problem_id as string,
      problem_title: r.problem_title as string,
      language: r.language as string,
      submitted_at: r.submitted_at as string,
      submitted_by: r.submitted_by as string,
      kind,
    };
    if (r.judge_started_at !== undefined) {
      item.judge_started_at = r.judge_started_at as string | null;
    }
    if (r.judge_finished_at !== undefined) {
      item.judge_finished_at = r.judge_finished_at as string | null;
    }
    if (r.status !== undefined) item.status = r.status as string;
    if (r.score !== undefined) item.score = r.score as number | null;
    return item;
  });
}

/** `GET /api/v1/submissions/:id/status` 响应体。 */
export interface SubmissionStatusResponse {
  id: string;
  status: string;
  contest_id: string | null;
  /** 1-based 排队位置；null 表示不在等待队列中。 */
  queue_position: number | null;
  /** 当前 pending 队列总长度。 */
  queue_length: number | null;
  judge_started_at: string | null;
  judge_finished_at: string | null;
}

// ─── 内部工具 ──────────────────────────────────────────────────────

/**
 * 从 Redis 获取 pending 队列中的 submission_id 列表（按入队顺序）。
 *
 * `limit` 是**跨三级队列的总上限**：旧实现把 limit 分别应用到每个队列，
 * 调用方要 20 条却可能拿到 60 条。
 */
interface PendingSchedulingTask {
  submission_id: string;
  resource_pool?: JudgeQueuePool;
  run_id?: string;
  rejudge_seq?: number;
}

/** 等待诊断只有匹配当前评测轮次时才显示，拒绝任意 Worker 字段。 */
export function matchingResourceWaitReason(
  task: { run_id?: string; rejudge_seq?: number },
  value: unknown,
): "user_busy" | "memory" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const waiting = value as Record<string, unknown>;
  if (
    waiting.run_id !== (task.run_id ?? null) ||
    waiting.rejudge_seq !== (task.rejudge_seq ?? 0)
  ) return null;
  return waiting.reason === "user_busy" || waiting.reason === "memory"
    ? waiting.reason
    : null;
}
async function getPendingSchedulingTasks(
  limit: number,
): Promise<PendingSchedulingTask[]> {
  const redis = getRedis();
  if (redis.status !== "ready") {
    await redis.connect();
  }
  // NOJ-077：监控/列表路径默认不全量 LRANGE；limit<=0 时仍允许调用方按需取全量。
  const unlimited = limit <= 0;
  const raw: string[] = [];
  for (const queue of JUDGE_QUEUE_LIST) {
    if (!unlimited && raw.length >= limit) break;
    const end = unlimited ? -1 : Math.max(0, limit - raw.length - 1);
    raw.push(...await redis.lrange(queue, 0, end));
  }
  const tasks: PendingSchedulingTask[] = [];
  for (const item of raw) {
    try {
      const parsed = JSON.parse(item);
      if (typeof parsed.submission_id === "string") {
        tasks.push({
          submission_id: parsed.submission_id,
          ...(JUDGE_RESOURCE_POOLS.includes(parsed.resource_pool)
            ? { resource_pool: parsed.resource_pool }
            : {}),
          ...(typeof parsed.run_id === "string"
            ? { run_id: parsed.run_id }
            : {}),
          ...(Number.isSafeInteger(parsed.rejudge_seq)
            ? { rejudge_seq: parsed.rejudge_seq }
            : {}),
        });
      }
    } catch {
      logger.error("队列中存在无法解析的条目，已跳过");
    }
  }
  return tasks;
}

/** 从各池队列提取提交标识；源码和测试包不进入响应。 */
export async function getPendingSubmissionIds(
  limit = PENDING_LIST_LIMIT,
): Promise<string[]> {
  return (await getPendingSchedulingTasks(limit)).map((task) =>
    task.submission_id
  );
}

/** 获取 pending 队列实际长度（O(1)）。 */
export async function getPendingQueueLength(): Promise<number> {
  const redis = getRedis();
  if (redis.status !== "ready") {
    await redis.connect();
  }
  const lengths = await Promise.all(
    JUDGE_QUEUE_LIST.map((queue) => redis.llen(queue)),
  );
  return lengths.reduce((total, value) => total + Number(value ?? 0), 0);
}

/**
 * 计算提交在三级队列中的排队位置。
 *
 * 消费顺序为 high → medium → low，同一队列内 LRANGE 尾部（更早入队）先出队：
 * - `position`：按上述顺序估算的前方任务数 + 1（1 = 下一个出队）；
 * - `queueLength`：三级队列总长度；
 * - `position` 为 null 表示该提交不在任何主队列（可能正在评测或已出队）。
 */
export async function getPendingQueuePosition(
  submissionId: string,
): Promise<{ position: number | null; queueLength: number }> {
  const redis = getRedis();
  if (redis.status !== "ready") {
    await redis.connect();
  }
  const groups = JUDGE_QUEUE_LAYOUT === "legacy"
    ? [Object.values(JUDGE_QUEUES)]
    : JUDGE_RESOURCE_POOLS.map((pool) =>
      Object.values(JUDGE_POOL_QUEUES[pool])
    );
  for (const queues of groups) {
    const lengths = await Promise.all(queues.map((queue) => redis.llen(queue)));
    let ahead = 0;
    for (let index = 0; index < queues.length; index++) {
      if (!Number(lengths[index])) continue;
      const items = await redis.lrange(queues[index], 0, -1);
      const found = items.findIndex((raw) => {
        try {
          return JSON.parse(raw).submission_id === submissionId;
        } catch {
          return false;
        }
      });
      if (found !== -1) {
        return {
          position: ahead + items.length - found,
          queueLength: lengths.reduce(
            (total, length) => total + Number(length ?? 0),
            0,
          ),
        };
      }
      ahead += Number(lengths[index] ?? 0);
    }
  }
  return { position: null, queueLength: 0 };
}

/** 管理员移除尚未被 worker 领取的评测任务。 */
export async function removePendingSubmission(id: string): Promise<void> {
  const db = getDb();
  const [submission] = await db
    .select({ id: submissions.id, status: submissions.status })
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);
  if (!submission) {
    throw new NotFoundError("提交不存在");
  }

  const redis = getRedis();
  if (redis.status !== "ready") await redis.connect();
  let raw: string | undefined;
  let targetQueue: string | undefined;
  for (const queue of JUDGE_QUEUE_LIST) {
    const rawItems = await redis.lrange(queue, 0, -1);
    const found = rawItems.find((item) => {
      try {
        return JSON.parse(item).submission_id === id;
      } catch {
        return false;
      }
    });
    if (found) {
      raw = found;
      targetQueue = queue;
      break;
    }
  }
  if (!raw || !targetQueue) {
    throw new NotFoundError("待处理队列中不存在该提交");
  }
  const removed = await redis.lrem(targetQueue, 1, raw);
  if (removed !== 1) throw new NotFoundError("待处理队列中不存在该提交");

  if (submission.status === "judging") {
    await db.update(submissions).set({
      status: "error",
      judge_finished_at: new Date().toISOString(),
    })
      .where(and(eq(submissions.id, id), eq(submissions.status, "judging")));
  }

  await logAudit(
    "submissions.queue_removed",
    { action: "submissions.queue_removed", submission_id: id },
    { type: "submission", id },
  );
  await publishSseEvent(Channels.queue, { type: "queue:changed" });
}

/**
 * 获取 pending 队列快照。
 *
 * 队列长度不超过 PENDING_LIST_LIMIT 时走限量 LRANGE；
 * 超过时回退全量 LRANGE，保证队列位置与 judging 排除逻辑在积压场景下仍正确。
 */
export async function getPendingQueueSnapshot(): Promise<{
  ids: string[];
  length: number;
  scheduling: Map<string, PendingSchedulingTask>;
}> {
  const length = await getPendingQueueLength();
  const tasks = await getPendingSchedulingTasks(
    length > PENDING_LIST_LIMIT ? -1 : PENDING_LIST_LIMIT,
  );
  return {
    ids: tasks.map((task) => task.submission_id),
    length,
    scheduling: new Map(tasks.map((task) => [task.submission_id, task])),
  };
}

// ─── 公开 API ───────────────────────────────────────────────────────

/**
 * 自测查询的用户隔离条件（审计 VULN-11）。
 *
 * 非管理员且已登录 → 限定 `self_tests.user_id = viewerUserId`；
 * 非管理员且**未登录**（viewerUserId 缺失）→ `false`（一律看不到自测，
 * fail-closed：宁可空列表，也不泄露全站自测）。
 *
 * @returns 可直接展开进 `and(...)` 的条件数组（管理员为空数组 = 不过滤）。
 */
function selfTestScope(
  isAdmin: boolean,
  viewerUserId?: string,
): SQL[] {
  if (isAdmin) return [];
  if (!viewerUserId) return [sql`false`];
  return [eq(selfTests.user_id, viewerUserId)];
}

/**
 * 获取完整的队列概览。
 *
 * @param isAdmin 管理员可看到竞赛提交与**全站**自测；普通用户只能看到非竞赛提交。
 * @param viewerUserId 当前查看者 id（审计 VULN-11）：非管理员时，`self_tests`
 *        相关的 pending / judging / recently_completed / 统计全部按
 *        `user_id = viewerUserId` 过滤。此前这些查询完全不带用户约束，任何登录用户
 *        调用 `GET /api/v1/queue` 都能看到全站其他人的自测题目、提交者用户名与
 *        自测最终得分（`score`），违反自测服务对非所有者隐蔽的承诺。
 */
export async function getQueueOverview(
  isAdmin = false,
  viewerUserId?: string,
): Promise<QueueResponse> {
  const db = getDb();

  // 1. 从 Redis 获取 pending submission_id 列表。
  // NOJ-033：Redis 不可用时优雅降级——pending 为空、统计用 DB 数据，
  // 不向队列页面抛 500。
  let pendingIds: string[] = [];
  let pendingQueueLength = 0;
  let pendingScheduling = new Map<string, PendingSchedulingTask>();
  try {
    const snapshot = await getPendingQueueSnapshot();
    pendingIds = snapshot.ids;
    pendingQueueLength = snapshot.length;
    pendingScheduling = snapshot.scheduling;
  } catch (err) {
    logger.warn("Redis 不可用，队列 pending 信息降级为空", { err });
  }

  // 2. 查询 pending 提交/自测的元数据（保持 Redis 队列原有顺序）
  const pendingFormalIds = pendingIds.filter(
    (id) => !id.startsWith(SELF_TEST_ID_PREFIX),
  );
  const pendingSelfIds = pendingIds.filter((id) =>
    id.startsWith(SELF_TEST_ID_PREFIX)
  );
  const pendingMap = new Map<string, QueueItem>();

  if (pendingFormalIds.length > 0) {
    const pendingRows = await queryQueueRows(
      submissions,
      {
        id: submissions.id,
        problemId: submissions.problem_id,
        language: submissions.language,
        createdAt: submissions.created_at,
        userId: submissions.user_id,
      },
      "submission",
      isAdmin ? inArray(submissions.id, pendingFormalIds) : and(
        inArray(submissions.id, pendingFormalIds),
        isNull(submissions.contest_id),
      ),
    );
    for (const r of pendingRows) pendingMap.set(r.id, r);
  }

  if (pendingSelfIds.length > 0) {
    const pendingSelfRows = await queryQueueRows(
      selfTests,
      {
        id: selfTests.id,
        problemId: selfTests.problem_id,
        language: selfTests.language,
        createdAt: selfTests.created_at,
        userId: selfTests.user_id,
      },
      "self_test",
      // 非管理员只能看到自己的自测（审计 VULN-11）
      and(
        inArray(selfTests.id, pendingSelfIds),
        ...selfTestScope(isAdmin, viewerUserId),
      ),
    );
    for (const r of pendingSelfRows) pendingMap.set(r.id, r);
  }

  const pendingItems: QueueItem[] = pendingIds
    .map((id) => pendingMap.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .sort(
      (a, b) =>
        new Date(a.submitted_at).getTime() -
        new Date(b.submitted_at).getTime(),
    );
  const pendingCount = pendingQueueLength;

  // 4. 查询 judging 列表：DB status="judging" 且不在 pending 中
  const judgingConditions: SQL[] = [eq(submissions.status, "judging")];
  if (pendingFormalIds.length > 0) {
    judgingConditions.push(not(inArray(submissions.id, pendingFormalIds)));
  }
  if (!isAdmin) {
    judgingConditions.push(isNull(submissions.contest_id));
  }
  const judgingWhere = and(...judgingConditions);

  const submissionJudgingItems = await queryQueueRows(
    submissions,
    {
      id: submissions.id,
      problemId: submissions.problem_id,
      language: submissions.language,
      createdAt: submissions.created_at,
      userId: submissions.user_id,
      judgeStartedAt: submissions.judge_started_at,
    },
    "submission",
    judgingWhere,
    sql`${submissions.judge_started_at} ASC`,
  );

  const selfJudgingWhere = pendingSelfIds.length > 0
    ? and(
      eq(selfTests.status, "judging"),
      not(inArray(selfTests.id, pendingSelfIds)),
    )
    : eq(selfTests.status, "judging");

  const selfJudgingItems = await queryQueueRows(
    selfTests,
    {
      id: selfTests.id,
      problemId: selfTests.problem_id,
      language: selfTests.language,
      createdAt: selfTests.created_at,
      userId: selfTests.user_id,
      judgeStartedAt: selfTests.judge_started_at,
    },
    "self_test",
    and(selfJudgingWhere, ...selfTestScope(isAdmin, viewerUserId)),
    sql`${selfTests.judge_started_at} ASC`,
  );

  const judgingItems: QueueItem[] = [
    ...submissionJudgingItems,
    ...selfJudgingItems,
  ].sort((a, b) =>
    (a.judge_started_at ?? "").localeCompare(b.judge_started_at ?? "")
  );

  // 5. 查询 recently_completed：最近 10 条（正式 + 自测合并）
  const completedItems: QueueItem[] = [
    ...await queryQueueRows(
      submissions,
      {
        id: submissions.id,
        problemId: submissions.problem_id,
        language: submissions.language,
        createdAt: submissions.created_at,
        userId: submissions.user_id,
        judgeStartedAt: submissions.judge_started_at,
        judgeFinishedAt: submissions.judge_finished_at,
        status: submissions.status,
      },
      "submission",
      isAdmin ? sql`${submissions.status} IN ('finished', 'error')` : and(
        sql`${submissions.status} IN ('finished', 'error')`,
        isNull(submissions.contest_id),
      ),
      sql`${submissions.judge_finished_at} DESC`,
      10,
      {
        latest: submissions.latest_attempt_id,
        effective: submissions.effective_attempt_id,
      },
    ),
    ...await queryQueueRows(
      selfTests,
      {
        id: selfTests.id,
        problemId: selfTests.problem_id,
        language: selfTests.language,
        createdAt: selfTests.created_at,
        userId: selfTests.user_id,
        judgeStartedAt: selfTests.judge_started_at,
        judgeFinishedAt: selfTests.judge_finished_at,
        status: selfTests.status,
        score: selfTests.score,
      },
      "self_test",
      and(
        sql`${selfTests.status} IN ('finished', 'error')`,
        ...selfTestScope(isAdmin, viewerUserId),
      ),
      sql`${selfTests.judge_finished_at} DESC`,
      10,
    ),
  ].sort((a, b) =>
    (b.judge_finished_at ?? "").localeCompare(a.judge_finished_at ?? "")
  ).slice(0, 10);

  // 6. 统计（正式 + 自测）
  const judgingWhereConditions: SQL[] = [eq(submissions.status, "judging")];
  if (pendingFormalIds.length > 0) {
    judgingWhereConditions.push(not(inArray(submissions.id, pendingFormalIds)));
  }
  if (!isAdmin) {
    judgingWhereConditions.push(isNull(submissions.contest_id));
  }
  const judgingWhereStats = and(...judgingWhereConditions);

  const selfJudgingWhereStats = pendingSelfIds.length > 0
    ? and(
      eq(selfTests.status, "judging"),
      not(inArray(selfTests.id, pendingSelfIds)),
    )
    : eq(selfTests.status, "judging");

  const [judgingCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(submissions)
    .where(judgingWhereStats);

  const [selfJudgingCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(selfTests)
    .where(and(selfJudgingWhereStats, ...selfTestScope(isAdmin, viewerUserId)));

  const today = new Date().toISOString().slice(0, 10);
  const [completedTodayRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(submissions)
    .where(
      isAdmin
        ? sql`${submissions.status} IN ('finished', 'error') AND ${submissions.judge_finished_at} >= ${today}`
        : and(
          sql`${submissions.status} IN ('finished', 'error') AND ${submissions.judge_finished_at} >= ${today}`,
          isNull(submissions.contest_id),
        ),
    );

  const judgingCount = Number(judgingCountRow?.count ?? 0) +
    Number(selfJudgingCountRow?.count ?? 0);
  const completedToday = Number(completedTodayRow?.count ?? 0);
  const poolStats = Object.fromEntries(
    await Promise.all(JUDGE_RESOURCE_POOLS.map(async (pool) => {
      const queues = Object.values(JUDGE_POOL_QUEUES[pool]);
      const pending = await Promise.all(
        queues.map((queue) => getRedis().llen(queue)),
      );
      const processing = await Promise.all(
        queues.map((queue) => getRedis().llen(`${queue}:processing`)),
      );
      return [pool, {
        pending: pending.reduce((sum, value) => sum + Number(value), 0),
        processing: processing.reduce((sum, value) => sum + Number(value), 0),
      }];
    })),
  ) as NonNullable<QueueStats["pools"]>;
  const resourceMemory = { reserved_mb: 0, budget_mb: 0 };
  if (JUDGE_QUEUE_LAYOUT === "pools") {
    const health = await getQueueHealth();
    for (const group of Object.values(health.resource_groups ?? {})) {
      const capacities = group.capacities as
        | Record<string, unknown>
        | undefined;
      const active = group.active as Record<string, unknown> | undefined;
      if (!capacities || !active) continue;
      const safe = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? value
          : 0;
      resourceMemory.reserved_mb += safe(group.reserved_memory_mb);
      resourceMemory.budget_mb += safe(capacities.memory_mb);
      for (const pool of JUDGE_RESOURCE_POOLS) {
        if (
          Array.isArray(group.resource_pools) &&
          !group.resource_pools.includes(pool)
        ) continue;
        const stat = poolStats[pool];
        const key = pool === "oi-wasm"
          ? "wasm_tasks"
          : pool === "oi-native"
          ? "native_tasks"
          : "ai_tasks";
        stat.active = (stat.active ?? 0) + safe(active[pool]);
        stat.task_capacity = (stat.task_capacity ?? 0) + safe(capacities[key]);
        if (pool === "oi-wasm") {
          stat.compiling = (stat.compiling ?? 0) + safe(active.compile);
          stat.running = (stat.running ?? 0) + safe(active.run);
          stat.run_capacity = (stat.run_capacity ?? 0) +
            safe(capacities.wasm_run);
        }
      }
    }
  }

  // 仅查询已通过提交/比赛权限过滤的条目；等待原因与评测轮次绑定。
  await Promise.all(
    pendingItems.slice(0, PENDING_LIST_LIMIT).map(async (item) => {
      const task = pendingScheduling.get(item.id);
      if (!task?.resource_pool) return;
      item.resource_pool = task.resource_pool;
      const stat = poolStats[task.resource_pool];
      if (stat.task_capacity && (stat.active ?? 0) >= stat.task_capacity) {
        item.waiting_reason = "pool_full";
      }
      try {
        const raw = await getRedis().get(
          `${JUDGE_QUEUE_PREFIX}:waiting:${item.id}`,
        );
        if (!raw) return;
        const waiting = JSON.parse(raw);
        const reason = matchingResourceWaitReason(task, waiting);
        if (reason) item.waiting_reason = reason;
      } catch { /* Redis 异常时仍展示队列快照。 */ }
    }),
  );
  return {
    pending: pendingItems,
    judging: judgingItems,
    recently_completed: completedItems,
    stats: {
      pending_count: pendingCount,
      judging_count: judgingCount,
      completed_today: completedToday,
      ...(JUDGE_QUEUE_LAYOUT === "pools"
        ? { pools: poolStats, resource_memory: resourceMemory }
        : {}),
    },
  };
}

/**
 * 获取单个提交的队列状态。
 *
 * 权限控制（审计 VULN-13 修正）：**仅提交所有者本人或 admin** 可见。
 * 此前判据是 `viewerUserId !== undefined && viewerRole !== "admin"`，于是**匿名**
 * 访问（`viewerUserId === undefined`）反而跳过了归属校验、能拿到排队位置，
 * 而已登录的非所有者却被返回 null —— 权限逻辑完全倒挂。
 * 现在未登录访客与非所有者一样返回 null。
 *
 * @param submissionId 提交 ID
 * @param viewerUserId 当前查看者用户 ID（可选）
 * @param viewerRole 当前查看者角色（可选，"admin" 拥有所有权限）
 * @returns 队列状态；提交不存在或查看者无权访问时返回 null
 */
export async function getSubmissionQueueStatus(
  submissionId: string,
  viewerUserId?: string,
  viewerRole?: string,
): Promise<SubmissionStatusResponse | null> {
  const db = getDb();

  // 1. 查询提交基本信息（含 user_id 用于权限校验）
  const rows = await db
    .select({
      user_id: submissions.user_id,
      contest_id: submissions.contest_id,
      status: submissions.status,
      judge_started_at: submissions.judge_started_at,
      judge_finished_at: submissions.judge_finished_at,
    })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);

  if (rows.length === 0) return null;

  // 2. 权限校验：仅 admin 或提交所有者可查看（匿名访客同样被拒绝）
  if (viewerRole !== "admin") {
    if (!viewerUserId || rows[0].user_id !== viewerUserId) return null;
  }

  const row = rows[0];
  const status = row.status;
  let queuePosition: number | null = null;
  let queueLength: number | null = null;

  // 3. 如果状态是 judging 或 pending，查询排队位置
  //    注意：DB 中 status 在入队后立即标记为 judging，
  //    因此需要结合 Redis 队列判断实际排队情况
  //    Redis 不可用时静默失败，queue_position/queue_length 保持 null
  if (status === "judging" || status === "pending") {
    try {
      const info = await getPendingQueuePosition(submissionId);
      queueLength = info.queueLength;
      // 不在主队列中（正在评测或已出队）时 queue_position 保持 null
      queuePosition = info.position;
    } catch {
      // Redis 不可用时静默跳过，queue_position/queue_length 保持 null
    }
  }

  return {
    id: submissionId,
    status,
    contest_id: row.contest_id,
    queue_position: queuePosition,
    queue_length: queueLength,
    judge_started_at: row.judge_started_at ?? null,
    judge_finished_at: row.judge_finished_at ?? null,
  };
}

/**
 * 从 Redis 读取单个队列（主队列/processing/dead）的健康快照。
 *
 * 用于管理端队列状态页与健康检查。Redis 不可用或任一读取失败时：
 * - 长度字段返回 -1（调用方可据此判定 degraded）；
 * - 不抛出异常，避免健康检查本身把服务打挂。
 *
 * 注意：当前不暴露 processing 中最老消息的“真实年龄”，因为现有消息
 * 负载没有内建时间戳，无法在不扫描/反序列化每条消息的情况下可靠计算。
 * 这里只暴露 O(1) 的长度指标，避免提供误导性数据。
 */
async function readQueueHealth(mainQueue: string): Promise<QueueHealthEntry> {
  const redis = getRedis();
  if (redis.status !== "ready") {
    try {
      await redis.connect();
    } catch {
      return {
        queue_length: -1,
        processing_length: -1,
        dead_length: -1,
      };
    }
  }

  try {
    const [queueLength, processingLength, deadLength] = await Promise.all([
      redis.llen(mainQueue),
      redis.llen(`${mainQueue}:processing`),
      redis.llen(`${mainQueue}:dead`),
    ]);

    return {
      queue_length: Number(queueLength ?? 0),
      processing_length: Number(processingLength ?? 0),
      dead_length: Number(deadLength ?? 0),
    };
  } catch (err) {
    logger.warn("读取队列健康状态失败", { mainQueue, err });
    return {
      queue_length: -1,
      processing_length: -1,
      dead_length: -1,
    };
  }
}

/**
 * 聚合三个评测任务优先级队列的健康快照。
 *
 * 任一队列读取失败（-1）时整体返回 -1，避免把 degraded 状态误报为 0。
 */
async function readJudgeQueueHealth(): Promise<QueueHealthEntry> {
  const entries = await Promise.all(
    JUDGE_QUEUE_LIST.map((queue) => readQueueHealth(queue)),
  );
  const sum = (pick: (e: QueueHealthEntry) => number): number => {
    if (entries.some((e) => pick(e) < 0)) return -1;
    return entries.reduce((total, e) => total + pick(e), 0);
  };
  return {
    queue_length: sum((e) => e.queue_length),
    processing_length: sum((e) => e.processing_length),
    dead_length: sum((e) => e.dead_length),
  };
}

/**
 * 获取评测任务/结果队列的健康状态（管理端/运维用）。
 *
 * Redis 不可用时返回 `redis_ok: false`，各队列长度均为 -1。
 */
export async function getQueueHealth(): Promise<QueueHealthResponse> {
  const redis = getRedis();
  let redisOk = false;
  try {
    if (redis.status !== "ready") {
      await redis.connect();
    }
    await redis.ping();
    redisOk = true;
  } catch {
    redisOk = false;
  }

  const judge = await readJudgeQueueHealth();
  const result = await readQueueHealth(RESULT_QUEUE);
  const pools = Object.fromEntries(
    await Promise.all(JUDGE_RESOURCE_POOLS.map(async (pool) => {
      const entries = await Promise.all(
        Object.values(JUDGE_POOL_QUEUES[pool]).map(readQueueHealth),
      );
      const sum = (field: keyof QueueHealthEntry) =>
        entries.some((entry) => entry[field] < 0)
          ? -1
          : entries.reduce((total, entry) => total + entry[field], 0);
      return [pool, {
        queue_length: sum("queue_length"),
        processing_length: sum("processing_length"),
        dead_length: sum("dead_length"),
      }];
    })),
  ) as Record<JudgeQueuePool, QueueHealthEntry>;
  const resource_groups: Record<string, Record<string, unknown>> = Object
    .create(null);
  if (redisOk) {
    let cursor = "0";
    let scanned = 0;
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        "noj:observability:judge:*",
        "COUNT",
        100,
      );
      cursor = next;
      for (const key of keys) {
        if (++scanned > 1000) break;
        try {
          const raw = await redis.get(key);
          if (!raw) continue;
          const heartbeat = JSON.parse(raw);
          if (
            heartbeat.scheduling_version !== 1 ||
            typeof heartbeat.resource_group !== "string" || !heartbeat.resources
          ) continue;
          const previous = resource_groups[heartbeat.resource_group];
          const enabled = [
            ...new Set([
              ...(Array.isArray(previous?.resource_pools)
                ? previous.resource_pools
                : []),
              ...(Array.isArray(heartbeat.resource_pools)
                ? heartbeat.resource_pools.filter((pool: unknown) =>
                  JUDGE_RESOURCE_POOLS.includes(pool as JudgeQueuePool)
                )
                : []),
            ]),
          ];
          if (
            !previous ||
            Number(heartbeat.updated_at_ms) >= Number(previous.updated_at_ms)
          ) {
            resource_groups[heartbeat.resource_group] = {
              ...heartbeat.resources,
              updated_at_ms: heartbeat.updated_at_ms,
              scheduling_version: 1,
              resource_pools: enabled,
            };
          } else {
            previous.resource_pools = enabled;
          }
        } catch { /* 无效心跳不影响队列健康读取。 */ }
      }
    } while (cursor !== "0" && scanned <= 1000);
  }
  return {
    judge,
    result,
    pools,
    resource_groups,
    redis_ok: redisOk,
  };
}
