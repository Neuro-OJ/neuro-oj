// 队列概览：资源作用域谓词、队列行查询、自测隔离与队列概览接口。
import { and, eq, inArray, isNull, not, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domains,
  evaluationAttempts,
  problems,
  selfTests,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { getRedis } from "../../../../shared/mq/connection.ts";
import {
  JUDGE_POOL_QUEUES,
  JUDGE_QUEUE_LAYOUT,
  JUDGE_QUEUE_PREFIX,
  JUDGE_RESOURCE_POOLS,
} from "../../../../shared/mq/judge-queues.ts";
import { getLogger } from "@logtape/logtape";
import { unwrapRows } from "../../../../shared/base/sql-rows.ts";
import { SELF_TEST_ID_PREFIX } from "../../types/self-tests.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import {
  domainMemberWhere,
  domainReadableWhere,
} from "../../../access/contracts/cross-module/workspace_services_access.ts";
import { domainProblemBindingAvailableWhere } from "../../../problems/contracts/cross-module/services_workspace_binding-availability.ts";
import { unendedPublicContestForProblem } from "../../../contests/contracts/cross-module/services_problem-secrecy.ts";
import { projectContestSubmissionReads } from "../submissions/contest-read-projection.ts";
import type {
  QueueItem,
  QueueQueryScope,
  QueueResponse,
  QueueStats,
} from "../../types/queue.ts";
import {
  getPendingQueueSnapshot,
  matchingResourceWaitReason,
  PENDING_LIST_LIMIT,
  type PendingSchedulingTask,
} from "./pending.ts";
import { getQueueHealth } from "./health.ts";

const logger = getLogger(["noj", "submission"]);

function queueResourceScope(
  table: typeof submissions | typeof selfTests,
  scope: QueueQueryScope,
) {
  const domainId = scope.instance
    ? sql`coalesce(${table.domain_id},${DEFAULT_DOMAIN_ID})`
    : sql`${scope.domainId}`;
  const member = scope.instance
    ? sql`(${!!scope.platformAdmin} OR ${
      domainMemberWhere(domainId, scope.viewerId ?? null)
    })`
    : scope.member;
  const entered = scope.instance
    ? domainReadableWhere(domainId, scope.viewerId ?? null, scope.platformAdmin)
    : sql`(${table.domain_id}=${scope.domainId} OR (${table.domain_id} IS NULL AND ${
      scope.domainId === DEFAULT_DOMAIN_ID
    }))`;
  return sql`${entered}
 AND (${
    table === submissions
      ? sql`${submissions.contest_id} IS NOT NULL OR`
      : sql``
  } NOT ${
    unendedPublicContestForProblem(
      table === submissions ? submissions.problem_id : selfTests.problem_id,
      domainId,
    )
  })
 AND ((${table.domain_id} IS NULL AND ${table.domain_problem_binding_id} IS NULL) OR ${
    domainProblemBindingAvailableWhere(
      table.domain_problem_binding_id,
      domainId,
      { member },
    )
  })`;
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
  scope: QueueQueryScope,
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
    domain_id: kind === "submission"
      ? submissions.domain_id
      : selfTests.domain_id,
    domain_slug: domains.slug,
  };
  if (cols.judgeStartedAt) selectFields.judge_started_at = cols.judgeStartedAt;
  if (cols.judgeFinishedAt) {
    selectFields.judge_finished_at = cols.judgeFinishedAt;
  }
  if (cols.status) selectFields.status = cols.status;
  if (kind === "submission") {
    selectFields.contest_id = submissions.contest_id;
    selectFields.user_id = submissions.user_id;
  }
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
    .leftJoin(
      domains,
      sql`${domains.id}=coalesce(${
        kind === "submission" ? submissions.domain_id : selfTests.domain_id
      },${DEFAULT_DOMAIN_ID})`,
    )
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
  query = query.where(
    and(
      where,
      queueResourceScope(
        kind === "submission" ? submissions : selfTests,
        scope,
      ),
    ),
  );
  if (orderBy) query = query.orderBy(orderBy);
  if (limit !== undefined) query = query.limit(limit);

  // deno-lint-ignore no-explicit-any
  const rows: any[] = await query;
  const projected = kind === "submission"
    ? await projectContestSubmissionReads(
      rows.map((row) => ({
        id: row.id,
        problem_id: row.problem_id,
        user_id: row.user_id,
        contest_id: row.contest_id,
        status: row.status,
        score: row.score,
      })),
      scope.viewerId ?? null,
      scope.platformAdmin,
    )
    : null;
  return rows.map((r, index) => {
    const item: QueueItem = {
      id: r.id as string,
      problem_id: r.problem_id as string,
      problem_title: r.problem_title as string,
      language: r.language as string,
      submitted_at: r.submitted_at as string,
      submitted_by: r.submitted_by as string,
      kind,
      domain_id: r.domain_id as string,
      domain_slug: (r.domain_slug ?? "main") as string,
    };
    const safe = projected?.[index];
    const hidden = !!r.contest_id && safe &&
      (!Object.hasOwn(safe, "status") ||
        (safe as Record<string, unknown>).result_visibility === "hidden");
    if (!hidden && r.judge_started_at !== undefined) {
      item.judge_started_at = r.judge_started_at as string | null;
    }
    if (!hidden && r.judge_finished_at !== undefined) {
      item.judge_finished_at = r.judge_finished_at as string | null;
    }
    const visible = safe ?? r;
    if (visible.status !== undefined) item.status = visible.status as string;
    if (visible.score !== undefined) {
      item.score = visible.score as number | null;
    }
    return item;
  });
}

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

export async function getQueueOverview(
  isAdmin = false,
  viewerUserId?: string,
  scope: QueueQueryScope = { domainId: DEFAULT_DOMAIN_ID, member: isAdmin },
): Promise<QueueResponse> {
  scope = { ...scope, viewerId: viewerUserId, platformAdmin: isAdmin };
  const db = getDb();
  const formalAccess = isAdmin ? undefined : or(
    isNull(submissions.contest_id),
    eq(submissions.user_id, viewerUserId ?? ""),
  );

  // 1. 从 Redis 获取 pending submission_id 列表。
  // NOJ-033：Redis 不可用时优雅降级——pending 为空、统计用 DB 数据，
  // 不向队列页面抛 500。
  let pendingIds: string[] = [];
  let pendingScheduling = new Map<string, PendingSchedulingTask>();
  try {
    const snapshot = await getPendingQueueSnapshot();
    pendingIds = snapshot.ids;
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
      scope,
      and(inArray(submissions.id, pendingFormalIds), formalAccess),
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
      scope,
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
  const pendingCount = pendingItems.length;

  // 4. 查询 judging 列表：DB status="judging" 且不在 pending 中
  const judgingConditions: SQL[] = [eq(submissions.status, "judging")];
  if (pendingFormalIds.length > 0) {
    judgingConditions.push(not(inArray(submissions.id, pendingFormalIds)));
  }
  if (!isAdmin) {
    judgingConditions.push(formalAccess!);
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
    scope,
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
    scope,
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
      scope,
      isAdmin ? sql`${submissions.status} IN ('finished', 'error')` : and(
        sql`${submissions.status} IN ('finished', 'error')`,
        formalAccess,
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
      scope,
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
    judgingWhereConditions.push(formalAccess!);
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
    .where(and(judgingWhereStats, queueResourceScope(submissions, scope)));

  const [selfJudgingCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(selfTests)
    .where(
      and(
        selfJudgingWhereStats,
        ...selfTestScope(isAdmin, viewerUserId),
        queueResourceScope(selfTests, scope),
      ),
    );

  const today = new Date().toISOString().slice(0, 10);
  const [completedTodayRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(submissions)
    .where(
      and(
        queueResourceScope(submissions, scope),
        isAdmin
          ? sql`${submissions.status} IN ('finished', 'error') AND ${submissions.judge_finished_at} >= ${today}`
          : and(
            sql`${submissions.status} IN ('finished', 'error') AND ${submissions.judge_finished_at} >= ${today}`,
            formalAccess,
          ),
      ),
    );

  const judgingCount = Number(judgingCountRow?.count ?? 0) +
    Number(selfJudgingCountRow?.count ?? 0);
  const [completedSelfToday] = await db.select({
    count: sql<number>`count(*)::int`,
  }).from(selfTests).where(and(
    sql`${selfTests.status} IN ('finished','error') AND ${selfTests.judge_finished_at}>=${today}`,
    ...selfTestScope(isAdmin, viewerUserId),
    queueResourceScope(selfTests, scope),
  ));
  const completedToday = Number(completedTodayRow?.count ?? 0) +
    Number(completedSelfToday?.count ?? 0);
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
  if ((isAdmin || scope.instance) && JUDGE_QUEUE_LAYOUT === "pools") {
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
  let globalCounts: {
    pending: number;
    judging: number;
    completed_today: number;
  } | undefined;
  if (scope.instance) {
    const rows = await db.execute(sql`SELECT
      (SELECT count(*)::int FROM submissions WHERE status='judging' AND ${
      pendingFormalIds.length
        ? not(inArray(submissions.id, pendingFormalIds))
        : sql`true`
    }) + (SELECT count(*)::int FROM self_tests WHERE status='judging' AND ${
      pendingSelfIds.length
        ? not(inArray(selfTests.id, pendingSelfIds))
        : sql`true`
    }) AS judging,
      (SELECT count(*)::int FROM submissions WHERE status IN ('finished','error') AND judge_finished_at>=${today}) +
      (SELECT count(*)::int FROM self_tests WHERE status IN ('finished','error') AND judge_finished_at>=${today}) AS completed_today`);
    const [counts] = unwrapRows<{ judging: number; completed_today: number }>(
      rows as never,
    );
    globalCounts = {
      pending: pendingIds.length,
      judging: Number(counts.judging),
      completed_today: Number(counts.completed_today),
    };
  }
  return {
    pending: pendingItems,
    judging: judgingItems,
    recently_completed: completedItems,
    stats: {
      pending_count: globalCounts?.pending ?? pendingCount,
      judging_count: globalCounts?.judging ?? judgingCount,
      completed_today: globalCounts?.completed_today ?? completedToday,
      ...((isAdmin || scope.instance) && JUDGE_QUEUE_LAYOUT === "pools"
        ? { pools: poolStats, resource_memory: resourceMemory }
        : {}),
    },
    scope: scope.instance ? "instance" : "domain",
    visible_counts: {
      pending: pendingCount,
      judging: judgingCount,
      completed_today: completedToday,
    },
  };
}
