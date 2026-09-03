import { and, eq, inArray, not, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { getDb } from "./../../../shared/db/connection.ts";
import {
  evaluationResults,
  problems,
  selfTests,
  submissions,
  users,
} from "./../../../shared/db/schema.ts";
import { getRedis } from "../../../mq/connection.ts";
import { logger } from "./../../../shared/base/logging.ts";
import { NotFoundError } from "./../../../shared/base/errors.ts";
import { Channels, publishSseEvent } from "../../../lib/event-bus.ts";
import { logAudit } from "../../system/index.ts";
import { SELF_TEST_ID_PREFIX } from "../../../types/self-tests.ts";

/** 评测任务队列名称（与 producer.ts 一致）。 */
const JUDGE_QUEUE = "noj:judge:queue";

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
}

/** `GET /api/v1/queue` 完整响应体。 */
export interface QueueResponse {
  pending: QueueItem[];
  judging: QueueItem[];
  recently_completed: QueueItem[];
  stats: QueueStats;
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
 * 查询正式提交或自测的队列行，统一 JOIN problems/users（及可选的 evaluation_results）。
 */
async function queryQueueRows(
  table: AnyPgTable,
  cols: QueueTableColumns,
  kind: QueueItem["kind"],
  where: SQL | undefined,
  orderBy?: SQL,
  limit?: number,
  scoreFromEval = false,
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
  if (scoreFromEval) {
    selectFields.score = evaluationResults.score;
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
  if (scoreFromEval) {
    query = query.leftJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, cols.id),
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
 */
export async function getPendingSubmissionIds(
  limit = PENDING_LIST_LIMIT,
): Promise<string[]> {
  const redis = getRedis();
  if (redis.status !== "ready") {
    await redis.connect();
  }
  // NOJ-077：监控/列表路径默认不全量 LRANGE；limit<=0 时仍允许调用方按需取全量。
  const end = limit <= 0 ? -1 : Math.max(0, limit - 1);
  const raw = await redis.lrange(JUDGE_QUEUE, 0, end);
  const ids: string[] = [];
  for (const item of raw) {
    try {
      const parsed = JSON.parse(item);
      if (parsed.submission_id) {
        ids.push(parsed.submission_id);
      }
    } catch {
      logger.error("队列中存在无法解析的条目，已跳过", {
        content: item.slice(0, 200),
      });
    }
  }
  return ids;
}

/** 获取 pending 队列实际长度（O(1)）。 */
export async function getPendingQueueLength(): Promise<number> {
  const redis = getRedis();
  if (redis.status !== "ready") {
    await redis.connect();
  }
  return redis.llen(JUDGE_QUEUE);
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
  const rawItems = await redis.lrange(JUDGE_QUEUE, 0, -1);
  const raw = rawItems.find((item) => {
    try {
      return JSON.parse(item).submission_id === id;
    } catch {
      return false;
    }
  });
  if (!raw) throw new NotFoundError("待处理队列中不存在该提交");
  const removed = await redis.lrem(JUDGE_QUEUE, 1, raw);
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
}> {
  const length = await getPendingQueueLength();
  const ids = length > PENDING_LIST_LIMIT
    ? await getPendingSubmissionIds(-1)
    : await getPendingSubmissionIds();
  return { ids, length };
}

// ─── 公开 API ───────────────────────────────────────────────────────

/**
 * 获取完整的队列概览。
 */
export async function getQueueOverview(): Promise<QueueResponse> {
  const db = getDb();

  // 1. 从 Redis 获取 pending submission_id 列表。
  // NOJ-033：Redis 不可用时优雅降级——pending 为空、统计用 DB 数据，
  // 不向队列页面抛 500。
  let pendingIds: string[] = [];
  let pendingQueueLength = 0;
  try {
    const snapshot = await getPendingQueueSnapshot();
    pendingIds = snapshot.ids;
    pendingQueueLength = snapshot.length;
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
      inArray(submissions.id, pendingFormalIds),
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
      inArray(selfTests.id, pendingSelfIds),
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
  const judgingWhere = pendingFormalIds.length > 0
    ? and(
      eq(submissions.status, "judging"),
      not(inArray(submissions.id, pendingFormalIds)),
    )
    : eq(submissions.status, "judging");

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
    selfJudgingWhere,
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
      sql`${submissions.status} IN ('finished', 'error')`,
      sql`${submissions.judge_finished_at} DESC`,
      10,
      true,
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
      sql`${selfTests.status} IN ('finished', 'error')`,
      sql`${selfTests.judge_finished_at} DESC`,
      10,
    ),
  ].sort((a, b) =>
    (b.judge_finished_at ?? "").localeCompare(a.judge_finished_at ?? "")
  ).slice(0, 10);

  // 6. 统计（正式 + 自测）
  const judgingWhereStats = pendingFormalIds.length > 0
    ? and(
      eq(submissions.status, "judging"),
      not(inArray(submissions.id, pendingFormalIds)),
    )
    : eq(submissions.status, "judging");

  const selfJudgingWhereStats = pendingSelfIds.length > 0
    ? and(
      eq(selfTests.status, "judging"),
      not(inArray(selfTests.id, pendingSelfIds)),
    )
    : eq(selfTests.status, "judging");

  const [judgingCountRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(submissions)
    .where(judgingWhereStats);

  const [selfJudgingCountRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(selfTests)
    .where(selfJudgingWhereStats);

  const today = new Date().toISOString().slice(0, 10);
  const [completedTodayRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(submissions)
    .where(
      sql`${submissions.status} IN ('finished', 'error') AND ${submissions.judge_finished_at} >= ${today}`,
    );

  const judgingCount = Number(judgingCountRow?.count ?? 0) +
    Number(selfJudgingCountRow?.count ?? 0);
  const completedToday = Number(completedTodayRow?.count ?? 0);

  return {
    pending: pendingItems,
    judging: judgingItems,
    recently_completed: completedItems,
    stats: {
      pending_count: pendingCount,
      judging_count: judgingCount,
      completed_today: completedToday,
    },
  };
}

/**
 * 获取单个提交的队列状态。
 *
 * 权限控制：当传入 `viewerUserId` 时，仅返回该用户自己的提交状态（避免 IDOR）；
 * `viewerRole === 'admin'` 时可查看任意提交。两者均不传时按公开访问处理
 * （保留向后兼容，但生产路由不应走到此分支）。
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

  // 2. 权限校验：仅 admin 或提交所有者可查看
  if (viewerUserId !== undefined && viewerRole !== "admin") {
    if (rows[0].user_id !== viewerUserId) return null;
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
      const snapshot = await getPendingQueueSnapshot();
      queueLength = snapshot.length;
      const pendingIds = snapshot.ids;
      const idx = pendingIds.indexOf(submissionId);
      if (idx !== -1) {
        // LRANGE 返回最新优先（LPUSH），
        // pendingIds.length - idx 使队列位置从 1（下个出队）递增。
        // 超过 PENDING_LIST_LIMIT 时 snapshot 已回退全量，因此长度即真实队列长度。
        queuePosition = pendingIds.length - idx;
      }
    } catch {
      // Redis 不可用时静默跳过，queue_position/queue_length 保持 null
    }
    // 如果不在 pending 中且 status 为 judging，说明正在被评测
    // queue_position 保持 null
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
