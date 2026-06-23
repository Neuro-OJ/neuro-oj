import { and, eq, inArray, not, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  evaluationResults,
  problems,
  submissions,
  users,
} from "../db/schema.ts";
import { getRedis } from "../mq/connection.ts";

/** 评测任务队列名称（与 producer.ts 一致）。 */
const JUDGE_QUEUE = "noj:judge:queue";

// ─── 响应类型 ───────────────────────────────────────────────────────

/** 队列中的一个条目（pending / judging / recently_completed 共用）。 */
export interface QueueItem {
  id: string;
  problem_id: string;
  problem_title: string;
  language: string;
  submitted_at: string;
  submitted_by: string;
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

/** `GET /api/v1/submissions/:id/status` 响应体。 */
export interface SubmissionStatusResponse {
  id: string;
  status: string;
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
async function getPendingSubmissionIds(): Promise<string[]> {
  const redis = getRedis();
  const raw = await redis.lrange(JUDGE_QUEUE, 0, -1);
  const ids: string[] = [];
  for (const item of raw) {
    try {
      const parsed = JSON.parse(item);
      if (parsed.submission_id) {
        ids.push(parsed.submission_id);
      }
    } catch {
      // 跳过无法解析的条目
    }
  }
  return ids;
}

// ─── 公开 API ───────────────────────────────────────────────────────

/**
 * 获取完整的队列概览。
 */
export async function getQueueOverview(): Promise<QueueResponse> {
  const db = getDb();

  // 1. 从 Redis 获取 pending submission_id 列表
  const pendingIds = await getPendingSubmissionIds();

  // 2. 查询 pending 提交的元数据（保持 Redis 队列原有顺序）
  let pendingItems: QueueItem[] = [];
  if (pendingIds.length > 0) {
    const pendingRows = await db
      .select({
        id: submissions.id,
        problem_id: submissions.problem_id,
        problem_title: problems.title,
        language: submissions.language,
        submitted_at: submissions.created_at,
        submitted_by: users.username,
      })
      .from(submissions)
      .innerJoin(problems, eq(submissions.problem_id, problems.id))
      .innerJoin(users, eq(submissions.user_id, users.id))
      .where(inArray(submissions.id, pendingIds));

    const idMap = new Map(pendingRows.map((r) => [r.id, r]));
    // 保持 Redis 队列顺序 (LPUSH → LRANGE 0 -1 = 最新优先)
    // 但 API 规格要求按 submitted_at ASC 排序（先提交的先评测）
    pendingItems = pendingIds
      .map((id) => idMap.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .sort(
        (a, b) =>
          new Date(a.submitted_at).getTime() -
          new Date(b.submitted_at).getTime(),
      )
      .map((r) => ({
        id: r.id,
        problem_id: r.problem_id,
        problem_title: r.problem_title,
        language: r.language,
        submitted_at: r.submitted_at,
        submitted_by: r.submitted_by,
      }));
  }
  const pendingCount = pendingItems.length;

  // 4. 查询 judging 列表：DB status="judging" 且不在 pending 中
  const judgingWhere = pendingIds.length > 0
    ? and(
      eq(submissions.status, "judging"),
      not(inArray(submissions.id, pendingIds)),
    )
    : eq(submissions.status, "judging");

  const judgingRows = await db
    .select({
      id: submissions.id,
      problem_id: submissions.problem_id,
      problem_title: problems.title,
      language: submissions.language,
      submitted_at: submissions.created_at,
      submitted_by: users.username,
      judge_started_at: submissions.judge_started_at,
    })
    .from(submissions)
    .innerJoin(problems, eq(submissions.problem_id, problems.id))
    .innerJoin(users, eq(submissions.user_id, users.id))
    .where(judgingWhere)
    .orderBy(sql`${submissions.judge_started_at} ASC`);

  const judgingItems: QueueItem[] = judgingRows.map((r) => ({
    id: r.id,
    problem_id: r.problem_id,
    problem_title: r.problem_title,
    language: r.language,
    submitted_at: r.submitted_at,
    submitted_by: r.submitted_by,
    judge_started_at: r.judge_started_at,
  }));

  // 5. 查询 recently_completed：最近 10 条
  const completedRows = await db
    .select({
      id: submissions.id,
      problem_id: submissions.problem_id,
      problem_title: problems.title,
      language: submissions.language,
      submitted_at: submissions.created_at,
      submitted_by: users.username,
      judge_started_at: submissions.judge_started_at,
      judge_finished_at: submissions.judge_finished_at,
      status: submissions.status,
      score: evaluationResults.score,
    })
    .from(submissions)
    .innerJoin(problems, eq(submissions.problem_id, problems.id))
    .innerJoin(users, eq(submissions.user_id, users.id))
    .leftJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    )
    .where(sql`${submissions.status} IN ('finished', 'error')`)
    .orderBy(sql`${submissions.judge_finished_at} DESC`)
    .limit(10);

  const completedItems: QueueItem[] = completedRows.map((r) => ({
    id: r.id,
    problem_id: r.problem_id,
    problem_title: r.problem_title,
    language: r.language,
    submitted_at: r.submitted_at,
    submitted_by: r.submitted_by,
    judge_started_at: r.judge_started_at,
    judge_finished_at: r.judge_finished_at,
    status: r.status,
    score: r.score,
  }));

  // 6. 统计
  const judgingWhereStats = pendingIds.length > 0
    ? and(
      eq(submissions.status, "judging"),
      not(inArray(submissions.id, pendingIds)),
    )
    : eq(submissions.status, "judging");

  const [judgingCountRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(submissions)
    .where(judgingWhereStats);

  const today = new Date().toISOString().slice(0, 10);
  const [completedTodayRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(submissions)
    .where(
      sql`${submissions.status} IN ('finished', 'error') AND ${submissions.judge_finished_at} >= ${today}`,
    );

  const judgingCount = Number(judgingCountRow?.count ?? 0);
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
 */
export async function getSubmissionQueueStatus(
  submissionId: string,
): Promise<SubmissionStatusResponse | null> {
  const db = getDb();

  // 1. 查询提交基本信息
  const rows = await db
    .select({
      status: submissions.status,
      judge_started_at: submissions.judge_started_at,
      judge_finished_at: submissions.judge_finished_at,
    })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  const status = row.status;
  let queuePosition: number | null = null;
  let queueLength: number | null = null;

  // 2. 如果状态是 judging 或 pending，查询排队位置
  //    注意：DB 中 status 在入队后立即标记为 judging，
  //    因此需要结合 Redis 队列判断实际排队情况
  if (status === "judging" || status === "pending") {
    const pendingIds = await getPendingSubmissionIds();
    queueLength = pendingIds.length;
    const idx = pendingIds.indexOf(submissionId);
    if (idx !== -1) {
      queuePosition = idx + 1; // 1-based
    }
    // 如果不在 pending 中且 status 为 judging，说明正在被评测
    // queue_position 保持 null
  }

  return {
    id: submissionId,
    status,
    queue_position: queuePosition,
    queue_length: queueLength,
    judge_started_at: row.judge_started_at ?? null,
    judge_finished_at: row.judge_finished_at ?? null,
  };
}
