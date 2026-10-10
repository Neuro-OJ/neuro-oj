/**
 * 评测队列可靠性 sweeper（NOJ-067/NOJ-179）。
 *
 * 两个职责：
 * 1. processing 列表超时扫描：任务 10 分钟、结果 2 分钟仍未被确认时重投主队列；
 * 2. pending 提交恢复：创建/重测在「写 DB → 入队」之间崩溃留下的 pending
 *    提交，超过 2 分钟后自动重新构建 JudgeTask 入队。
 */

import { and, asc, eq, lte, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { getDb } from "../../../shared/db/connection.ts";
import { problems, selfTests, submissions } from "../../../shared/db/schema.ts";
import { getSetting } from "../../system/index.ts";
import { getRedis } from "../../../shared/mq/connection.ts";
import { listSweepTargets } from "../../../shared/mq/sweep-targets.ts";
import {
  ALL_JUDGE_QUEUES,
  isRetryableJudgeQueueError,
  JUDGE_QUEUE_CAPACITY,
} from "./producer.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "submission"]);
import type { JudgeTaskPriority } from "../types/index.ts";
import { AppError } from "../../../shared/base/errors.ts";
import { rebuildPendingTask } from "./pending-recovery.ts";
import { applyAttemptResult } from "../services/versioning/result-write.ts";

const RESULT_QUEUE = "noj:judge:results";

const TASK_PROCESSING_TIMEOUT_MS = 10 * 60_000;
const RESULT_PROCESSING_TIMEOUT_MS = 2 * 60_000;
const PENDING_RECOVERY_MS = 2 * 60_000;
const SWEEP_INTERVAL_MS = 30_000;

/** 根据管理员配置的最大 evaluator 时限推导任务 processing 超时，避免长任务被提前重投。 */
function taskProcessingTimeoutMs(): number {
  const setting = getSetting("judge_max_evaluator_time_limit_ms");
  const maxTimeLimit = typeof setting?.value === "number" ? setting.value : 0;
  if (maxTimeLimit <= 0) {
    return TASK_PROCESSING_TIMEOUT_MS;
  }
  // 至少保留 2 分钟结果推送/收尾余量。
  return Math.max(TASK_PROCESSING_TIMEOUT_MS, maxTimeLimit + 2 * 60_000);
}

const _firstSeen = new Map<string, number>();
const _lastRequeue = new Map<string, number>();

let _sweeperStarted = false;

/** 简单字符串 hash（仅用于内存去重/计时，不用于安全场景）。 */
function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return String(h >>> 0) + ":" + input.length;
}

function shouldRequeue(
  raw: string,
  now: number,
  timeoutMs: number,
): boolean {
  const hash = hashString(raw);
  const first = _firstSeen.get(hash);
  if (first === undefined) {
    _firstSeen.set(hash, now);
    return false;
  }
  const last = _lastRequeue.get(hash) ?? 0;
  return now - first >= timeoutMs && now - last >= timeoutMs;
}

function markRequeued(raw: string, now: number): void {
  const hash = hashString(raw);
  _firstSeen.set(hash, now);
  _lastRequeue.set(hash, now);
  if (_firstSeen.size > 2000) {
    for (const key of _firstSeen.keys()) {
      const at = _firstSeen.get(key) ?? 0;
      if (now - at > TASK_PROCESSING_TIMEOUT_MS * 4) {
        _firstSeen.delete(key);
        _lastRequeue.delete(key);
      }
    }
  }
}

/**
 * 原子执行「重投主队列 + 清空 processing 副本」。
 *
 * 必须使用 LPUSH（与 producer 入队方向一致）：
 * noj-judge 通过 BRPOPLPUSH 从队列尾部消费（FIFO），若使用 RPUSH 会将
 * 超时任务插队到队首（下一个立即被取走），导致 poison pill 任务死循环霸占 Worker。
 * 用单条 Lua 脚本保证二者原子完成；仅当 processing 中确实存在该消息时才重投。
 */
const REQUEUE_SCRIPT = `
local removed = redis.call('LREM', KEYS[1], 0, ARGV[1])
if removed > 0 then
  redis.call('LPUSH', KEYS[2], ARGV[1])
end
return removed
`;

async function sweepProcessingQueue(
  processingQueue: string,
  mainQueue: string,
  timeoutMs: number,
): Promise<void> {
  const redis = getRedis();
  if (redis.status !== "ready") {
    try {
      await redis.connect();
    } catch {
      return;
    }
  }

  // 注意：BRPOPLPUSH 把消息压入 processing 头部，最早卡住的消息在尾部；
  // 必须从尾部扫描，否则积压超过 1000 条时老消息永远不会被重投。
  const rawItems = await redis.lrange(processingQueue, -1000, -1);
  const now = Date.now();
  for (const raw of rawItems) {
    if (!shouldRequeue(raw, now, timeoutMs)) continue;
    try {
      const removed = Number(
        await redis.eval(REQUEUE_SCRIPT, 2, processingQueue, mainQueue, raw),
      );
      if (removed > 0) {
        markRequeued(raw, now);
        logger.warn("processing 消息超时，已重投主队列", {
          processing: processingQueue,
          main: mainQueue,
        });
      }
    } catch (err) {
      logger.error("processing 消息重投失败", { err });
    }
  }
}

export interface PendingRecoveryRow {
  id: string;
  language: string;
  code: string;
  file_name: string | null;
  rejudge_seq?: number;
  problem_id: string;
  runtime_config: unknown;
  support_package_storage_url: string | null;
  judge_started_at?: string | null;
  user_id?: string;
  contest_id?: string | null;
  /** 在途评测尝试（正式提交）；恢复时以它绑定的版本为唯一配置来源。 */
  active_attempt_id?: string | null;
  /** 自测绑定版本（自测没有评测尝试记录）。 */
  problem_version_id?: string | null;
  /** 产物对象引用（artifact 提交）：保留到提交显式删除，恢复时重新生成下载 URL。 */
  artifact_storage_url?: string | null;
  judge_run_id?: string | null;
  task_snapshot?: Record<string, unknown> | null;
}

interface PendingRecoveryActions<T extends PendingRecoveryRow> {
  /** 日志字段名：提交用 submission_id，自测用 self_test_id。 */
  idKey: "submission_id" | "self_test_id";
  /** 日志展示名。 */
  label: "提交" | "自测";
  /** 缺少 runtime_config 时的处理（自行记录日志并收尾）。 */
  onMissingRuntimeConfig(row: T): void | Promise<void>;
  /** 入队成功后更新行状态（可保留原始 judge_started_at）。 */
  onEnqueued(row: T): void | Promise<void>;
  /** 永久入队失败（消息超限等）时标记 error。 */
  onPermanentError(row: T, err: unknown): void | Promise<void>;
}

/** pending 恢复查询所需的表列集合。 */
interface PendingRecoveryTableColumns {
  id: AnyPgColumn;
  language: AnyPgColumn;
  code: AnyPgColumn;
  file_name: AnyPgColumn;
  problemId: AnyPgColumn;
  createdAt: AnyPgColumn;
  runtimeConfig: AnyPgColumn;
  supportPackageStorageUrl: AnyPgColumn;
  rejudgeSeq?: AnyPgColumn;
  userId?: AnyPgColumn;
  judgeStartedAt?: AnyPgColumn;
  contestId?: AnyPgColumn;
  activeAttemptId?: AnyPgColumn;
  problemVersionIdCol?: AnyPgColumn;
  artifactStorageUrl?: AnyPgColumn;
  judgeRunId?: AnyPgColumn;
  taskSnapshot?: AnyPgColumn;
}

/**
 * 查询 pending 恢复行（正式提交或自测），统一 JOIN problems。
 */
async function selectPendingRecoveryRows(
  table: AnyPgTable,
  cols: PendingRecoveryTableColumns,
  where: SQL | undefined,
): Promise<PendingRecoveryRow[]> {
  const db = getDb();
  const selectFields: Record<string, unknown> = {
    id: cols.id,
    language: cols.language,
    code: cols.code,
    file_name: cols.file_name,
    problem_id: cols.problemId,
    runtime_config: cols.runtimeConfig,
    support_package_storage_url: cols.supportPackageStorageUrl,
  };
  if (cols.rejudgeSeq) selectFields.rejudge_seq = cols.rejudgeSeq;
  if (cols.userId) selectFields.user_id = cols.userId;
  if (cols.judgeStartedAt) selectFields.judge_started_at = cols.judgeStartedAt;
  if (cols.contestId) selectFields.contest_id = cols.contestId;
  if (cols.activeAttemptId) {
    selectFields.active_attempt_id = cols.activeAttemptId;
  }
  if (cols.problemVersionIdCol) {
    selectFields.problem_version_id = cols.problemVersionIdCol;
  }
  if (cols.artifactStorageUrl) {
    selectFields.artifact_storage_url = cols.artifactStorageUrl;
  }

  if (cols.judgeRunId) selectFields.judge_run_id = cols.judgeRunId;
  if (cols.taskSnapshot) selectFields.task_snapshot = cols.taskSnapshot;

  // 动态列集合无法保留 Drizzle 的精确查询类型，这里使用 any 收窄到内部契约。
  // deno-lint-ignore no-explicit-any
  const rows: any[] = await (db
    // deno-lint-ignore no-explicit-any
    .select(selectFields as any)
    .from(table)
    .innerJoin(problems, eq(cols.problemId, problems.id))
    .where(where)
    .orderBy(asc(cols.createdAt))
    .limit(200));
  return rows as PendingRecoveryRow[];
}

/**
 * 恢复 pending 记录通用流程：构建 JudgeTask → 入队 → 更新状态。
 * 正式提交与自测共用同一套恢复逻辑，仅保留各自的表更新/日志差异。
 */
async function recoverPendingRows<T extends PendingRecoveryRow>(
  rows: T[],
  actions: PendingRecoveryActions<T>,
  source: "submission" | "self_test",
): Promise<void> {
  for (const row of rows) {
    let task;
    try {
      task = await rebuildPendingTask(row, source);
    } catch (err) {
      // 缺失不可变版本/交付物或退役 Provider 是永久失败；基础设施暂时不可达继续等待。
      if (err instanceof AppError && err.statusCode < 500) {
        await actions.onPermanentError(row, err);
      } else {
        logger.error("pending 恢复暂时失败，等待下轮", {
          [actions.idKey]: row.id,
          err,
        });
      }
      continue;
    }

    const { pushJudgeTask } = await import("./producer.ts");
    try {
      await pushJudgeTask(task);
      await actions.onEnqueued(row);
      logger.info("已恢复 pending {label}入队", {
        label: actions.label,
        [actions.idKey]: row.id,
      });
    } catch (err) {
      if (!isRetryableJudgeQueueError(err)) {
        // 永久错误（消息超限等）：标记 error，避免每轮 sweeper 无限重试。
        await actions.onPermanentError(row, err);
        logger.error("pending {label}因永久入队失败标记为 error", {
          label: actions.label,
          [actions.idKey]: row.id,
          err,
        });
        continue;
      }
      logger.error("pending {label}恢复失败（等待下轮重试）", {
        label: actions.label,
        [actions.idKey]: row.id,
        err,
      });
    }
  }
}

/**
 * 恢复因“写 DB → 入队”窗口失败而遗留的正式提交。
 * 导出给 MQ 回归测试复用，生产入口仍由 runQueueSweeperOnce 调用。
 */
export async function recoverPendingSubmissions(now: number): Promise<void> {
  const cutoff = new Date(now - PENDING_RECOVERY_MS).toISOString();
  const db = getDb();

  const rows = await selectPendingRecoveryRows(
    submissions,
    {
      id: submissions.id,
      language: submissions.language,
      code: submissions.code,
      file_name: submissions.file_name,
      problemId: submissions.problem_id,
      createdAt: submissions.created_at,
      runtimeConfig: problems.runtime_config,
      supportPackageStorageUrl: problems.support_package_storage_url,
      rejudgeSeq: submissions.rejudge_seq,
      userId: submissions.user_id,
      contestId: submissions.contest_id,
      activeAttemptId: submissions.active_attempt_id,
      artifactStorageUrl: submissions.artifact_storage_url,
    },
    and(
      eq(submissions.status, "pending"),
      lte(submissions.created_at, cutoff),
      // 批任务由自己的持久化租约与退避负责派发，不能被 sweeper 抢先执行。
      sql`NOT EXISTS (SELECT 1 FROM submission_job_items ji WHERE ji.attempt_id = ${submissions.active_attempt_id} AND ji.status IN ('pending', 'preparing', 'dispatched'))`,
    ),
  );

  await recoverPendingRows(rows, {
    idKey: "submission_id",
    label: "提交",
    onMissingRuntimeConfig: async (row) => {
      await db.update(submissions)
        .set({
          status: "error",
          judge_finished_at: new Date().toISOString(),
        })
        .where(
          and(eq(submissions.id, row.id), eq(submissions.status, "pending")),
        );
      logger.error("pending 提交缺少 runtime_config，标记为 error", {
        submission_id: row.id,
      });
    },
    onEnqueued: async (row) => {
      await db.update(submissions)
        .set({ status: "judging" })
        .where(
          and(eq(submissions.id, row.id), eq(submissions.status, "pending")),
        );
    },
    onPermanentError: async (row, err) => {
      if (row.active_attempt_id) {
        await applyAttemptResult({
          attemptId: row.active_attempt_id,
          resultKind: "platform_error",
          resultStatus: "RECOVERY_FAILED",
          score: null,
          accepted: false,
          output: err instanceof Error ? err.message : String(err),
        });
      } else {
        await db.update(submissions).set({
          status: "error",
          judge_finished_at: new Date().toISOString(),
        }).where(
          and(eq(submissions.id, row.id), eq(submissions.status, "pending")),
        );
      }
    },
  }, "submission");
}

/**
 * 恢复自测 pending 记录（与正式提交同队列，需同样防孤儿）。
 */
export async function recoverPendingSelfTests(now: number): Promise<void> {
  const cutoff = new Date(now - PENDING_RECOVERY_MS).toISOString();
  const db = getDb();

  const rows = await selectPendingRecoveryRows(
    selfTests,
    {
      id: selfTests.id,
      language: selfTests.language,
      code: selfTests.code,
      file_name: selfTests.file_name,
      problemId: selfTests.problem_id,
      createdAt: selfTests.created_at,
      runtimeConfig: problems.runtime_config,
      supportPackageStorageUrl: problems.support_package_storage_url,
      judgeStartedAt: selfTests.judge_started_at,
      problemVersionIdCol: selfTests.problem_version_id,
      judgeRunId: selfTests.judge_run_id,
      taskSnapshot: selfTests.task_snapshot,
      userId: selfTests.user_id,
    },
    and(
      eq(selfTests.status, "pending"),
      lte(selfTests.created_at, cutoff),
    ),
  );

  await recoverPendingRows(rows, {
    idKey: "self_test_id",
    label: "自测",
    onMissingRuntimeConfig: async (row) => {
      await db.update(selfTests)
        .set({
          status: "error",
          judge_finished_at: new Date().toISOString(),
        })
        .where(eq(selfTests.id, row.id));
      logger.error("pending 自测缺少 runtime_config，标记为 error", {
        self_test_id: row.id,
      });
    },
    onEnqueued: async (row) => {
      await db.update(selfTests)
        .set({
          status: "judging",
          // 恢复时保留原始 judge_started_at；只有原本为空才补当前时间。
          judge_started_at: row.judge_started_at ?? new Date().toISOString(),
        })
        .where(
          and(eq(selfTests.id, row.id), eq(selfTests.status, "pending")),
        );
    },
    onPermanentError: async (row) => {
      await db.update(selfTests)
        .set({
          status: "error",
          // 永久失败保留可解释的原因码（不写成泛化的 PLATFORM_ERROR）
          result_status: "RECOVERY_FAILED",
          judge_finished_at: new Date().toISOString(),
        })
        .where(
          and(eq(selfTests.id, row.id), eq(selfTests.status, "pending")),
        );
    },
  }, "self_test");
}

/**
 * 产物提交的 pending 恢复已并入 {@link recoverPendingRows}：
 * 产物对象保留到提交显式删除，recovery 重新签发下载 URL 并入队，
 * 不再存在"超时即删除对象并标记 error"的不可恢复路径（Handbook §6.5）。
 */
/**
 * 队列告警去抖状态：同一异常只在上“升沿”记录一次，恢复后复位。
 */
const _alertStates = new Map<string, boolean>();

/** 结果队列积压告警阈值：达到最大队列容量的一半时告警。 */
const RESULT_QUEUE_ALERT_THRESHOLD = 10_000;

/**
 * 检查评测队列是否存在需要运维关注的异常，并在状态变化时输出告警日志。
 *
 * 当前只对“死信队列非空”和“主队列积压过半”告警；processing 由 sweeper
 * 自己重投，不单独告警，避免误报。Redis 不可用/长度为 -1 时跳过。
 */
async function logQueueAlertsIfNeeded(): Promise<void> {
  const redis = getRedis();
  if (redis.status !== "ready") {
    try {
      await redis.connect();
    } catch {
      return;
    }
  }

  const queues = [
    ...ALL_JUDGE_QUEUES.map((queue) => ({
      key: `judge:${queue}`,
      main: queue,
      capacity:
        JUDGE_QUEUE_CAPACITY[queue.split(":").at(-1) as JudgeTaskPriority],
    })),
    {
      key: "result",
      main: RESULT_QUEUE,
      capacity: RESULT_QUEUE_ALERT_THRESHOLD,
    },
  ] as const;

  for (const { key, main, capacity } of queues) {
    try {
      const [queueLength, deadLength] = await Promise.all([
        redis.llen(main),
        redis.llen(`${main}:dead`),
      ]);

      const threshold = capacity / 2;
      const queueAlert = Number(queueLength ?? 0) >= threshold;
      const deadAlert = Number(deadLength ?? 0) > 0;

      const alertKeyQueue = `${key}:queue`;
      const alertKeyDead = `${key}:dead`;

      if (queueAlert && !_alertStates.get(alertKeyQueue)) {
        logger.warn("评测队列积压超过阈值", {
          queue: main,
          queue_length: Number(queueLength ?? 0),
          threshold,
        });
        _alertStates.set(alertKeyQueue, true);
      } else if (!queueAlert && _alertStates.get(alertKeyQueue)) {
        _alertStates.set(alertKeyQueue, false);
      }

      if (deadAlert && !_alertStates.get(alertKeyDead)) {
        logger.error("评测队列出现死信消息，请及时处理", {
          queue: main,
          dead_length: Number(deadLength ?? 0),
        });
        _alertStates.set(alertKeyDead, true);
      } else if (!deadAlert && _alertStates.get(alertKeyDead)) {
        _alertStates.set(alertKeyDead, false);
      }
    } catch (err) {
      logger.warn("评测队列告警检查失败", { queue: main, err });
    }
  }
}

export async function runQueueSweeperOnce(): Promise<void> {
  const now = Date.now();
  const judgeQueues = ALL_JUDGE_QUEUES;

  // 评测三级队列与结果队列由 core/judge 直接约定（judge 侧写入 processing），
  // 保持硬编码；其余消费者队列从登记表读取（createConsumer 自动登记），
  // 避免"新增消费者忘记加进 sweeper 队列清单"导致消息永久滞留
  //（2026-09-12 评审 §2.5：noj:search:index / noj:review:dm 此前就是这种状态）。
  const coreSwept = new Set<string>([...judgeQueues, RESULT_QUEUE]);
  const registeredTargets = listSweepTargets().filter(
    (t) => !coreSwept.has(t.queueName),
  );

  const results = await Promise.allSettled([
    ...judgeQueues.map((queue) =>
      sweepProcessingQueue(
        `${queue}:processing`,
        queue,
        taskProcessingTimeoutMs(),
      )
    ),
    sweepProcessingQueue(
      `${RESULT_QUEUE}:processing`,
      RESULT_QUEUE,
      RESULT_PROCESSING_TIMEOUT_MS,
    ),
    ...registeredTargets.map((target) =>
      sweepProcessingQueue(
        `${target.queueName}:processing`,
        target.queueName,
        target.processingTimeoutMs,
      )
    ),
    recoverPendingSubmissions(now),
    recoverPendingSelfTests(now),
    logQueueAlertsIfNeeded(),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      logger.error("队列 sweeper 子任务失败", { err: result.reason });
    }
  }
}

/** 启动后台 sweeper（幂等）。 */
export function startQueueSweeper(): void {
  if (_sweeperStarted) return;
  _sweeperStarted = true;
  setInterval(() => {
    void runQueueSweeperOnce().catch((err) => {
      logger.error("队列 sweeper 执行失败", { err });
    });
  }, SWEEP_INTERVAL_MS);
}

/** 测试用。 */
export function _resetSweeperStateForTest(): void {
  _firstSeen.clear();
  _lastRequeue.clear();
}
