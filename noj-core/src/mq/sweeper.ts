/**
 * 评测队列可靠性 sweeper（NOJ-067/NOJ-179）。
 *
 * 两个职责：
 * 1. processing 列表超时扫描：任务 10 分钟、结果 2 分钟仍未被确认时重投主队列；
 * 2. pending 提交恢复：创建/重测在「写 DB → 入队」之间崩溃留下的 pending
 *    提交，超过 2 分钟后自动重新构建 JudgeTask 入队。
 */

import { and, eq, lte } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { problems, submissions } from "../db/schema.ts";
import { getStorageProvider } from "../lib/storage/mod.ts";
import { getRedis } from "./connection.ts";
import { JUDGE_QUEUE } from "./producer.ts";
import { logger } from "../lib/logging.ts";
import type { JudgeTask } from "../types/index.ts";
import type { RuntimeConfig } from "../types/problems.ts";
import { LANGUAGE_EXT_MAP } from "../types/index.ts";

const RESULT_QUEUE = "noj:judge:results";

const TASK_PROCESSING_TIMEOUT_MS = 10 * 60_000;
const RESULT_PROCESSING_TIMEOUT_MS = 2 * 60_000;
const PENDING_RECOVERY_MS = 2 * 60_000;
const SWEEP_INTERVAL_MS = 30_000;

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

  const rawItems = await redis.lrange(processingQueue, 0, 999);
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

async function recoverPendingSubmissions(now: number): Promise<void> {
  const cutoff = new Date(now - PENDING_RECOVERY_MS).toISOString();
  const db = getDb();

  const rows = await db
    .select({
      id: submissions.id,
      language: submissions.language,
      code: submissions.code,
      file_name: submissions.file_name,
      rejudge_seq: submissions.rejudge_seq,
      problem_id: submissions.problem_id,
      runtime_config: problems.runtime_config,
      support_package_storage_url: problems.support_package_storage_url,
    })
    .from(submissions)
    .innerJoin(problems, eq(submissions.problem_id, problems.id))
    .where(
      and(
        eq(submissions.status, "pending"),
        lte(submissions.created_at, cutoff),
      ),
    )
    .limit(200);

  for (const row of rows) {
    const runtimeConfig = row.runtime_config as RuntimeConfig | null;
    if (!runtimeConfig) {
      logger.error("pending 提交缺少 runtime_config，跳过恢复", {
        submission_id: row.id,
      });
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
          submission_id: row.id,
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
      rejudge_seq: row.rejudge_seq,
    };

    const { pushJudgeTask } = await import("./producer.ts");
    try {
      await pushJudgeTask(task);
      await db.update(submissions)
        .set({ status: "judging" })
        .where(eq(submissions.id, row.id));
      logger.info("已恢复 pending 提交入队", { submission_id: row.id });
    } catch (err) {
      logger.error("pending 提交恢复失败（等待下轮重试）", {
        submission_id: row.id,
        err,
      });
    }
  }
}

export async function runQueueSweeperOnce(): Promise<void> {
  const now = Date.now();
  await Promise.allSettled([
    sweepProcessingQueue(
      `${JUDGE_QUEUE}:processing`,
      JUDGE_QUEUE,
      TASK_PROCESSING_TIMEOUT_MS,
    ),
    sweepProcessingQueue(
      `${RESULT_QUEUE}:processing`,
      RESULT_QUEUE,
      RESULT_PROCESSING_TIMEOUT_MS,
    ),
    recoverPendingSubmissions(now),
  ]);
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
