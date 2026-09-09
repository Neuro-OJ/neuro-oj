import { getRedis } from "../../../shared/mq/connection.ts";
import {
  JUDGE_QUEUES,
  LEGACY_JUDGE_QUEUE,
} from "../../../shared/mq/judge-queues.ts";
import { logger } from "../../../shared/base/logging.ts";

/**
 * 旧单队列一次性迁移。
 *
 * 三级优先级队列把单队列 `noj:judge:queue` 拆成 `:high/:medium/:low`，
 * 升级瞬间仍留在旧队列或其 `:processing` 列表里的任务不会被新的 judge
 * 消费，也不会被 sweeper 扫描，会永久停留在 pending/judging。
 *
 * 本模块在 noj-core 启动时把旧队列中的消息补上 `priority: "medium"`
 * 后搬入 medium 队列；逐条用 Lua 保证「从旧列表移除 + 推入新队列」原子完成，
 * 因此可重入：崩溃后下次启动继续迁移剩余消息，不会重复投递。
 */

/** 旧单队列的 processing 列表名。 */
export const LEGACY_PROCESSING_QUEUE = `${LEGACY_JUDGE_QUEUE}:processing`;

/**
 * 为旧消息补充优先级字段（纯函数，便于单测）。
 *
 * 旧消息没有 `priority` 字段，judge 的 `JudgeTask` 反序列化会失败并丢进死信。
 * 迁移统一按 medium 处理：不把历史任务抬成 high，避免干扰正在进行中的竞赛。
 *
 * @returns 补全后的 JSON 字符串；无法解析时返回 null（交给死信/人工处理）
 */
export function withLegacyPriority(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.priority === "string" && parsed.priority) return raw;
    return JSON.stringify({ ...parsed, priority: "medium" });
  } catch {
    return null;
  }
}

/**
 * 原子搬运一条消息：仅当它仍在旧列表中时才推入新队列。
 *
 * 返回 1 表示搬运成功，0 表示消息已不在旧列表（已被其他实例搬走）。
 */
const MIGRATE_ONE_SCRIPT = `
local removed = redis.call('LREM', KEYS[1], 1, ARGV[1])
if removed > 0 then
  redis.call('LPUSH', KEYS[2], ARGV[2])
  return 1
end
return 0
`;

/** 单条消息的迁移结果统计。 */
export interface LegacyMigrationResult {
  /** 旧主队列中搬运成功的条数。 */
  fromMain: number;
  /** 旧 processing 列表中搬运成功的条数。 */
  fromProcessing: number;
  /** 无法解析、留在旧列表由人工处理的条数。 */
  unparsable: number;
}

/**
 * 把旧单队列中的任务迁移到三级队列（medium）。
 *
 * 幂等：旧列表中的消息被逐条 LREM 后不再存在，重复调用不会重复投递。
 * 失败不抛异常（启动流程不可因此中断），只记录日志。
 */
export async function migrateLegacyJudgeQueue(): Promise<
  LegacyMigrationResult
> {
  const result: LegacyMigrationResult = {
    fromMain: 0,
    fromProcessing: 0,
    unparsable: 0,
  };
  const redis = getRedis();
  if (redis.status !== "ready") {
    try {
      await redis.connect();
    } catch (err) {
      logger.warn("旧评测队列迁移跳过：Redis 不可用", { err });
      return result;
    }
  }

  const target = JUDGE_QUEUES.medium;
  for (
    const [source, key] of [
      [LEGACY_JUDGE_QUEUE, "fromMain"],
      [LEGACY_PROCESSING_QUEUE, "fromProcessing"],
    ] as const
  ) {
    let rawItems: string[];
    try {
      rawItems = await redis.lrange(source, 0, -1);
    } catch (err) {
      logger.error("旧评测队列读取失败，跳过该列表", { source, err });
      continue;
    }
    for (const raw of rawItems) {
      const migrated = withLegacyPriority(raw);
      if (migrated === null) {
        result.unparsable += 1;
        logger.error("旧评测队列存在无法解析的消息，保留原样待人工处理", {
          source,
          raw: raw.slice(0, 200),
        });
        continue;
      }
      try {
        const moved = Number(
          await redis.eval(
            MIGRATE_ONE_SCRIPT,
            2,
            source,
            target,
            raw,
            migrated,
          ),
        );
        if (moved > 0) result[key] += 1;
      } catch (err) {
        logger.error("旧评测队列消息迁移失败，将在下次启动重试", {
          source,
          err,
        });
      }
    }
  }

  if (result.fromMain || result.fromProcessing || result.unparsable) {
    logger.warn("旧单队列任务已迁移至三级队列", {
      legacy_queue: LEGACY_JUDGE_QUEUE,
      target,
      ...result,
    });
  }
  return result;
}
