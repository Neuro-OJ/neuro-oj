/**
 * 评测队列可靠性 sweeper（NOJ-067/NOJ-179）。
 *
 * 两个职责：
 * 1. processing 列表超时扫描：任务 10 分钟、结果 2 分钟仍未被确认时重投主队列；
 * 2. pending 提交恢复：创建/重测在「写 DB → 入队」之间崩溃留下的 pending
 *    提交，超过 2 分钟后自动重新构建 JudgeTask 入队。
 */

import { and, asc, eq, isNull, lte, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { getDb } from "./../shared/db/connection.ts";
import { problems, selfTests, submissions } from "./../shared/db/schema.ts";
import { getStorageProvider } from "../lib/storage/mod.ts";
import { getSetting } from "../domains/system/index.ts";
import { getRedis } from "./../shared/mq/connection.ts";
import { isRetryableJudgeQueueError, JUDGE_QUEUE } from "./producer.ts";
import { logger } from "./../shared/base/logging.ts";
import type { JudgeTask } from "../types/index.ts";
import type { RuntimeConfig } from "../types/problems.ts";
import { LANGUAGE_EXT_MAP } from "../types/index.ts";
import { buildJudgeTaskLlmForProvider } from "../lib/llm-token.ts";
import { getUserLlmProvider } from "../domains/gateway/index.ts";

const RESULT_QUEUE = "noj:judge:results";

const TASK_PROCESSING_TIMEOUT_MS = 10 * 60_000;
const RESULT_PROCESSING_TIMEOUT_MS = 2 * 60_000;
const PENDING_RECOVERY_MS = 2 * 60_000;
const ARTIFACT_PENDING_CLEANUP_MS = 10 * 60_000;
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
      // 先 RPUSH 回主队列（LPUSH 生产 / BRPOP 消费的 FIFO 语义下，RPUSH 落在最老端），
      // 再清空 processing 中该 payload 的所有副本。
      await redis.rpush(mainQueue, raw);
      await redis.lrem(processingQueue, 0, raw);
      markRequeued(raw, now);
      logger.warn("processing 消息超时，已重投主队列", {
        processing: processingQueue,
        main: mainQueue,
      });
    } catch (err) {
      logger.error("processing 消息重投失败", { err });
    }
  }
}

interface PendingRecoveryRow {
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
  llm_provider_config_id?: string | null;
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
  llmProviderConfigId?: AnyPgColumn;
  judgeStartedAt?: AnyPgColumn;
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
  if (cols.llmProviderConfigId) {
    selectFields.llm_provider_config_id = cols.llmProviderConfigId;
  }
  if (cols.judgeStartedAt) selectFields.judge_started_at = cols.judgeStartedAt;

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
): Promise<void> {
  for (const row of rows) {
    const runtimeConfig = row.runtime_config as RuntimeConfig | null;
    if (!runtimeConfig) {
      await actions.onMissingRuntimeConfig(row);
      continue;
    }

    let download_url: string | undefined;
    if (row.support_package_storage_url) {
      try {
        const storage = await getStorageProvider();
        download_url = await storage.downloadUrl(
          row.support_package_storage_url,
        );
      } catch (err) {
        logger.error("pending 恢复获取支持包失败，将以无支持包任务继续", {
          [actions.idKey]: row.id,
          err,
        });
      }
    }

    const task: JudgeTask = {
      submission_id: row.id,
      problem_id: row.problem_id,
      runtime_config: runtimeConfig,
      download_url,
      language: row.language,
      code: row.code,
      file_name: row.file_name ??
        (LANGUAGE_EXT_MAP[row.language] || "main.txt"),
      ...(row.rejudge_seq !== undefined
        ? { rejudge_seq: row.rejudge_seq }
        : {}),
    };

    if (row.user_id && row.llm_provider_config_id) {
      try {
        const provider = await getUserLlmProvider(
          row.user_id,
          row.llm_provider_config_id,
        );
        if (provider.enabled) {
          task.user_llm = await buildJudgeTaskLlmForProvider(
            provider.id,
            provider.model,
            row.id,
            row.problem_id,
            row.user_id,
            runtimeConfig,
          );
        }
      } catch (err) {
        logger.warn(
          "pending 提交的 BYOK 配置不可用，将继续以无 BYOK 任务恢复",
          {
            submission_id: row.id,
            err,
          },
        );
      }
    }

    const { pushJudgeTask } = await import("./producer.ts");
    try {
      await pushJudgeTask(task);
      await actions.onEnqueued(row);
      logger.info(`已恢复 pending ${actions.label}入队`, {
        [actions.idKey]: row.id,
      });
    } catch (err) {
      if (!isRetryableJudgeQueueError(err)) {
        // 永久错误（消息超限等）：标记 error，避免每轮 sweeper 无限重试。
        await actions.onPermanentError(row, err);
        logger.error(`pending ${actions.label}因永久入队失败标记为 error`, {
          [actions.idKey]: row.id,
          err,
        });
        continue;
      }
      logger.error(`pending ${actions.label}恢复失败（等待下轮重试）`, {
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
      llmProviderConfigId: submissions.llm_provider_config_id,
    },
    and(
      eq(submissions.status, "pending"),
      isNull(submissions.artifact_storage_url),
      lte(submissions.created_at, cutoff),
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
    onPermanentError: async (row) => {
      await db.update(submissions)
        .set({
          status: "error",
          judge_finished_at: new Date().toISOString(),
        })
        .where(
          and(eq(submissions.id, row.id), eq(submissions.status, "pending")),
        );
    },
  });
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
          judge_finished_at: new Date().toISOString(),
        })
        .where(
          and(eq(selfTests.id, row.id), eq(selfTests.status, "pending")),
        );
    },
  });
}

/**
 * 清理孤儿 artifact 提交：超过 N 分钟仍处于 pending 的 artifact 提交，
 * 删除其存储对象并标记为 error（artifact 不支持重测，不重新入队）。
 */
export async function cleanupOrphanArtifacts(now: number): Promise<void> {
  const cutoff = new Date(now - ARTIFACT_PENDING_CLEANUP_MS).toISOString();
  const db = getDb();

  const rows = await db
    .select({
      id: submissions.id,
      artifact_storage_url: submissions.artifact_storage_url,
    })
    .from(submissions)
    .where(
      and(
        eq(submissions.status, "pending"),
        sql`${submissions.artifact_storage_url} IS NOT NULL`,
        lte(submissions.created_at, cutoff),
      ),
    )
    .limit(200);

  const storage = await getStorageProvider();
  for (const row of rows) {
    if (row.artifact_storage_url) {
      try {
        await storage.delete(row.artifact_storage_url);
      } catch (err) {
        logger.error("清理孤儿 artifact 存储对象失败", {
          submission_id: row.id,
          storage_url: row.artifact_storage_url,
          err,
        });
      }
    }
    await db.update(submissions)
      .set({
        status: "error",
        judge_finished_at: new Date().toISOString(),
      })
      .where(
        and(eq(submissions.id, row.id), eq(submissions.status, "pending")),
      );
    logger.warn("孤儿 artifact 提交已清理并标记 error", {
      submission_id: row.id,
    });
  }
}

export async function runQueueSweeperOnce(): Promise<void> {
  const now = Date.now();
  const results = await Promise.allSettled([
    sweepProcessingQueue(
      `${JUDGE_QUEUE}:processing`,
      JUDGE_QUEUE,
      taskProcessingTimeoutMs(),
    ),
    sweepProcessingQueue(
      `${RESULT_QUEUE}:processing`,
      RESULT_QUEUE,
      RESULT_PROCESSING_TIMEOUT_MS,
    ),
    recoverPendingSubmissions(now),
    recoverPendingSelfTests(now),
    cleanupOrphanArtifacts(now),
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
