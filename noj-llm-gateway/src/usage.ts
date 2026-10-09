/**
 * LLM 调用审计写入。
 */
import type { Db } from "./db.ts";
import type { RedisClient } from "./redis.ts";
import { logger } from "./logger.ts";

export interface UsageEntry {
  id: string;
  submission_id: string;
  /** 评测尝试 ID（版本化后必填；旧 core 缺省为 null） */
  attempt_id?: string | null;
  /** 评测使用的题目版本（版本化后必填；旧 core 缺省为 null） */
  problem_version_id?: string | null;
  problem_id: string;
  user_id: string;
  provider_id: string;
  model: string;
  request_messages: unknown;
  request_params: unknown;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_prompt_tokens?: number;
  billed_prompt_tokens?: number;
  billed_total_tokens?: number;
  estimated_cost: number;
  latency_ms: number;
  status: string;
  error_code?: string | null;
  prompt_hash: string;
  created_at: string;
}

/** 限制单条审计记录中 request_messages 大小，避免超大包塞爆 DB（GW-03）。 */
const MAX_STORED_MESSAGES_BYTES = 64 * 1024;

function sanitizeMessagesForStorage(messages: unknown): unknown {
  try {
    const serialized = JSON.stringify(messages);
    if (serialized.length <= MAX_STORED_MESSAGES_BYTES) {
      return messages;
    }
    return [
      {
        role: "system",
        content:
          `[messages_truncated: original size ${serialized.length} bytes exceeded 64KB limit]`,
      },
    ];
  } catch {
    return [];
  }
}

/** 写入一条 LLM 用量审计记录；调用方负责在成功/失败/拒绝各分支调用。 */
export async function recordUsage(db: Db, entry: UsageEntry): Promise<void> {
  const safeMessages = sanitizeMessagesForStorage(entry.request_messages);
  await db`
    INSERT INTO llm_usage (
      id, submission_id, attempt_id, problem_version_id, problem_id, user_id, provider_id, model,
      request_messages, request_params, prompt_tokens, completion_tokens,
      total_tokens, cached_prompt_tokens, billed_prompt_tokens,
      billed_total_tokens, estimated_cost, latency_ms, status, error_code,
      prompt_hash, created_at
    ) VALUES (
      ${entry.id}, ${entry.submission_id}, ${entry.attempt_id ?? null},
      ${entry.problem_version_id ?? null},
      ${entry.problem_id}, ${entry.user_id},
      ${entry.provider_id}, ${entry.model}, ${JSON.stringify(safeMessages)},
      ${JSON.stringify(entry.request_params)}, ${entry.prompt_tokens},
      ${entry.completion_tokens}, ${entry.total_tokens},
      ${entry.cached_prompt_tokens ?? 0}, ${entry.billed_prompt_tokens ?? 0},
      ${entry.billed_total_tokens ?? 0}, ${entry.estimated_cost},
      ${entry.latency_ms}, ${entry.status}, ${entry.error_code ?? null},
      ${entry.prompt_hash}, ${entry.created_at}
    )
  `;
}

/** 调用前拒绝记录的去重窗口（秒）：同一提交 + 同一拒绝原因在窗口内只落一条。 */
export const REJECTED_DEDUP_WINDOW_SECONDS = 60;

/**
 * 写入一条"调用前即被拒绝"（限流/额度不足，未调用上游）的审计记录（G-04）。
 *
 * 与 `recordUsage` 的差异：
 * - **不保存 prompt 原文**：上游从未被调用，原文无计费/复盘价值，只保留 `prompt_hash`
 *   供关联；否则沙箱可借被拒请求把任意内容长期写进数据库；
 * - **按提交 + 拒绝原因去重**：窗口内重复拒绝只计指标、不落库，使被拒请求的
 *   写库量与请求速率脱钩，消除"无前置条件的持久化 DoS"。去重标记存 Redis（多副本共享）；
 *   Redis 不可用时退化为照常写入（拒绝本身已由限流逻辑完成，审计宁多勿漏）。
 *
 * @returns 是否实际写入了记录。
 */
export async function recordRejectedUsage(
  db: Db,
  redis: RedisClient,
  entry: UsageEntry,
): Promise<boolean> {
  // 去重键按**尝试**优先：同一提交的重测是独立预算，拒绝窗口也必须独立，
  // 否则新尝试的首次拒绝会被旧尝试的窗口吞掉（旧 core 回退提交维度）。
  const dedupKey = `llm:usage:rejected:${
    entry.attempt_id ?? entry.submission_id
  }:${entry.error_code ?? "unknown"}`;
  let first = true;
  try {
    first = await redis.setNx(dedupKey, "1", REJECTED_DEDUP_WINDOW_SECONDS);
  } catch {
    first = true;
  }
  if (!first) return false;
  await recordUsage(db, {
    ...entry,
    request_messages: [],
  });
  return true;
}

/** 单批删除的行数上限：避免首次清理时一条 DELETE 长时间持锁。 */
const PRUNE_BATCH_SIZE = 5000;

/**
 * 删除早于保留期的 `llm_usage` 记录（G-04：此前该表无任何清理，只增不减）。
 *
 * `created_at` 为 ISO 8601 文本，按字典序比较即按时间比较；分批删除直到不足一批。
 *
 * @param retentionDays 保留天数；≤0 表示不清理。
 * @param now 当前时间（测试注入）。
 * @returns 删除的总行数。
 */
export async function pruneUsage(
  db: Db,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000)
    .toISOString();
  let total = 0;
  while (true) {
    const rows = await db`
      DELETE FROM llm_usage
      WHERE id IN (
        SELECT id FROM llm_usage WHERE created_at < ${cutoff}
        LIMIT ${PRUNE_BATCH_SIZE}
      )
      RETURNING id
    `;
    total += rows.length;
    if (rows.length < PRUNE_BATCH_SIZE) break;
  }
  return total;
}

/** 清理任务间隔：6 小时。 */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 多副本互斥锁 TTL（秒）：略短于间隔，保证同一轮只有一个副本执行。 */
const PRUNE_LOCK_TTL_SECONDS = 5 * 60 * 60;

/**
 * 执行一轮保留期清理：先抢 Redis 互斥锁（多副本只跑一个），失败只记日志不抛出。
 *
 * @returns 删除的行数；未抢到锁或保留期关闭时为 0。
 */
export async function runUsageRetention(
  db: Db,
  redis: RedisClient,
  retentionDays: number,
): Promise<number> {
  if (retentionDays <= 0) return 0;
  try {
    const locked = await redis.setNx(
      "llm:usage:prune:lock",
      "1",
      PRUNE_LOCK_TTL_SECONDS,
    );
    if (!locked) return 0;
    const deleted = await pruneUsage(db, retentionDays);
    if (deleted > 0) {
      logger.info("llm_usage 保留期清理: 删除 {deleted} 行（保留 {days} 天）", {
        deleted,
        days: retentionDays,
      });
    }
    return deleted;
  } catch (err) {
    logger.warn("llm_usage 保留期清理失败: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * 启动周期性保留期清理（启动时立即执行一次，之后每 6 小时一次）。
 *
 * @returns 停止函数（测试/优雅关闭用）。
 */
export function startUsageRetention(
  db: Db,
  redis: RedisClient,
  retentionDays: number,
): () => void {
  if (retentionDays <= 0) return () => {};
  void runUsageRetention(db, redis, retentionDays);
  const timer = setInterval(
    () => void runUsageRetention(db, redis, retentionDays),
    PRUNE_INTERVAL_MS,
  );
  Deno.unrefTimer(timer);
  return () => clearInterval(timer);
}
