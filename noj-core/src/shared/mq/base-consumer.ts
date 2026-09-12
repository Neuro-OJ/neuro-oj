import { createConsumerRedis } from "./connection.ts";
import type { RedisClient } from "./connection.ts";
import {
  _resetSweepTargetsForTest,
  registerSweepTarget,
} from "./sweep-targets.ts";
import { logger } from "../base/logging.ts";

export interface ConsumerOptions {
  queueName: string;
  logLabel: string; // e.g. "结果", "评测开始事件"
  aliveRef: { value: boolean };
  /**
   * 处理消息。正常返回表示成功并会从 processing 列表确认；
   * 抛出异常表示处理失败，调用方会将其重新投递回主队列。
   */
  handleMessage: (data: Record<string, unknown>) => Promise<void>;
  /** BRPOPLPUSH timeout in seconds */
  blpopTimeout?: number;
  /** 处理失败后立即重投；false 时仅由 sweeper 超时重投（默认 true）。 */
  requeueOnError?: boolean;
  /**
   * 本队列的 processing 超时（毫秒），超过即由 sweeper 重投。
   * 默认 15 分钟——足够长，避免正常长任务被误重投（重投是 at-least-once 语义）。
   */
  processingTimeoutMs?: number;
}

const DEFAULT_BLPOP_TIMEOUT = 10;
const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
/** 单次启动最多重投多少条 processing 残留消息（防御性上限，避免异常积压拖慢启动）。 */
const MAX_STALE_REQUEUE_PER_START = 10_000;
/** 消费者未声明时的 processing 超时默认值（sweeper 兜底判定用）。 */
const DEFAULT_PROCESSING_TIMEOUT_MS = 15 * 60_000;

/**
 * 消费者句柄：既是启动函数（`handle()` 不返回，直到进程关闭），
 * 也带一个**只作用于本实例**的关闭入口。
 */
export interface ConsumerHandle {
  (): Promise<void>;
  /** 只停本消费者实例，不影响同进程内的其他消费者。 */
  requestShutdown(): void;
}

/**
 * 每个消费者实例独立的关闭标记。
 *
 * 修复记录（2026-09-12 架构评审 §2.5）：此前是**单个模块级布尔量**，被三个消费者
 * （评测结果 / 搜索索引 / 私信审核）共享——任一消费者请求关闭会同时停掉其余两个；
 * `shutdownSearchIndexConsumer()` 这种"只关自己"的语义实际会停掉全部消费者。
 * 现改为每实例独立标记；`requestConsumerShutdown()` 保留原语义（关停**全部**，
 * 用于进程优雅退出）。
 */
interface ConsumerShutdownState {
  requested: boolean;
}

const activeConsumers = new Set<ConsumerShutdownState>();

/**
 * 已执行过 processing 兜底重投的队列（每进程每队列一次）。
 *
 * 见 `requeueStaleProcessing`：多副本/同队列多消费者时，只有第一个启动的消费者
 * 执行兜底，避免在兄弟消费者正在处理消息时把它们"抢"回主队列。
 */
const processingRequeuedQueues = new Set<string>();

/** 优雅关闭：请求**所有**消费者退出（BRPOPLPUSH 使未确认消息仍在 processing 列表）。 */
export function requestConsumerShutdown(): void {
  for (const state of activeConsumers) state.requested = true;
}

/** 测试用：复位关闭标记与 processing 兜底记录。 */
export function _resetConsumerShutdownForTest(): void {
  for (const state of activeConsumers) state.requested = false;
  activeConsumers.clear();
  processingRequeuedQueues.clear();
  _resetSweepTargetsForTest();
}

/**
 * 把本队列 `:processing` 中的残留消息重投回主队列（启动期兜底）。
 *
 * 背景（2026-09-12 架构评审 §2.5）：`BRPOPLPUSH` 会把消息移入 `:processing`，
 * 消费者在"已取走、未 ACK"窗口内进程被杀（或 Redis 连接中断）时消息就停留在
 * `:processing`。此前只有评测结果队列有 sweeper 超时扫描兜底，
 * `noj:search:index`（异步搜索索引投影，源域写库后 fire-and-forget 投递）与
 * `noj:review:dm` 的残留消息会**永久滞留且不可自愈**——搜索索引静默落后，
 * 直到有人手工跑 `search reindex`。
 *
 * 这里把兜底放进 `createConsumer` 基类，使**新接入的消费者自动获得该保障**，
 * 而不是要求每个队列都记得去改 sweeper 的队列清单。
 *
 * 约束：
 * - 每进程每队列只执行一次（`processingRequeuedQueues`）：避免同队列的兄弟消费者
 *   在重连重启时把正在被他人处理的消息抢回主队列；
 * - 用 `RPOPLPUSH` 原子搬运，不会丢消息；
 * - 失败只告警不阻断启动（sweeper 仍是第二道防线）。
 *
 * @returns 本次实际重投的消息条数（跳过或失败时为 0）
 */
export async function requeueStaleProcessing(
  redis: RedisClient,
  queueName: string,
  processingQueue: string,
  label: string,
): Promise<number> {
  if (processingRequeuedQueues.has(queueName)) return 0;
  try {
    let moved = 0;
    // processing 由 BRPOPLPUSH push 到左侧，故尾部是最早未确认的消息；
    // RPOPLPUSH 逐个搬到主队列头部，顺序得到保留（不依赖 LRANGE 快照）。
    for (;;) {
      const item = await redis.rpoplpush(processingQueue, queueName);
      if (!item) break;
      moved++;
      if (moved > MAX_STALE_REQUEUE_PER_START) {
        logger.warn(
          `${label} processing 残留消息超过单次重投上限，剩余部分交给 sweeper 兜底`,
          {
            queue: processingQueue,
            limit: MAX_STALE_REQUEUE_PER_START,
          },
        );
        break;
      }
    }
    processingRequeuedQueues.add(queueName);
    if (moved > 0) {
      logger.warn(`${label}检测到上次未确认的消息，已重投回主队列`, {
        queue: queueName,
        moved,
      });
    }
    return moved;
  } catch (err) {
    logger.error(`${label} processing 残留消息重投失败（等待 sweeper 兜底）`, {
      queue: processingQueue,
      err,
    });
    return 0;
  }
}

/**
 * Create a consumer with automatic reconnection using exponential backoff.
 *
 * 可靠消费语义（NOJ-066/NOJ-074/NOJ-179）：
 * - BRPOPLPUSH 先把消息移入 processing 列表，处理成功后 LREM 确认；
 * - 处理抛错立即 RPUSH 回主队列并移除 processing 条目；
 * - **启动时**把本队列 processing 的残留消息重投回主队列（见 requeueStaleProcessing，
 *   2026-09-12 评审 §2.5：此前只有评测结果队列有 sweeper 兜底，
 *   `noj:search:index` / `noj:review:dm` 的残留消息会永久滞留，搜索索引静默落后）；
 * - 定期兜底由 sweeper 负责（超时重投）。
 *
 * @returns 启动函数（不返回，直到进程关闭）；带 `requestShutdown()` 可只停本实例。
 */
export function createConsumer(opts: ConsumerOptions): ConsumerHandle {
  const blpopTimeout = opts.blpopTimeout ?? DEFAULT_BLPOP_TIMEOUT;
  const label = opts.logLabel;
  const processingQueue = `${opts.queueName}:processing`;
  const requeueOnError = opts.requeueOnError ?? true;
  const state: ConsumerShutdownState = { requested: false };
  activeConsumers.add(state);

  // 自动登记 sweeper 兜底目标：新增消费者无需再手工维护 sweeper 的队列清单。
  registerSweepTarget({
    queueName: opts.queueName,
    processingTimeoutMs: opts.processingTimeoutMs ??
      DEFAULT_PROCESSING_TIMEOUT_MS,
  });

  const startConsumerWithRetry = async function (): Promise<void> {
    let retryCount = 0;

    try {
      while (!state.requested) {
        opts.aliveRef.value = false;

        logger.info(`${label}消费者正在启动...`);

        try {
          await runConsumer();
        } catch (err) {
          logger.error(`${label}消费者异常退出`, { err });
        }

        opts.aliveRef.value = false;
        if (state.requested) break;

        const delay = Math.min(
          INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount),
          MAX_RETRY_DELAY_MS,
        );
        retryCount++;

        logger.warn(`${label}消费者将重启`, {
          delay_ms: delay,
          retry: retryCount,
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      // 退出后从注册表移除：之后的全局关闭请求不再作用于已停止的实例。
      activeConsumers.delete(state);
    }
  };

  return Object.assign(startConsumerWithRetry, {
    requestShutdown: () => {
      state.requested = true;
    },
  });

  async function runConsumer(): Promise<void> {
    const redis = createConsumerRedis();
    try {
      await redis.connect();
    } catch (err) {
      logger.error(`${label}消费者 Redis 连接失败`, { err });
      await redis.disconnect();
      return;
    }

    await requeueStaleProcessing(redis, opts.queueName, processingQueue, label);

    opts.aliveRef.value = true;
    logger.info(`${label}消费者启动，等待事件...`);

    while (!state.requested) {
      let rawJson: string | null = null;
      try {
        rawJson = await redis.brpoplpush(
          opts.queueName,
          processingQueue,
          blpopTimeout,
        ) as string | null;
        if (!rawJson) continue;

        let message: Record<string, unknown>;
        try {
          message = JSON.parse(rawJson);
        } catch {
          logger.error(`${label} JSON 解析失败，移入死信队列`, {
            raw: rawJson.slice(0, 512),
          });
          // 坏消息不能无限循环：先保留到 :dead 队列便于审计，再从 processing 移除。
          const deadQueue = `${opts.queueName}:dead`;
          try {
            await redis.rpush(deadQueue, rawJson);
          } catch (deadErr) {
            logger.error(`${label} 写入死信队列失败`, { err: deadErr });
          }
          await redis.lrem(processingQueue, 1, rawJson);
          continue;
        }

        try {
          await opts.handleMessage(message);
          const removed = await redis.lrem(processingQueue, 1, rawJson);
          if (removed === 0) {
            logger.warn(
              `${label} processing 确认未命中（可能已被 sweeper 重投）`,
              {
                queue: processingQueue,
              },
            );
          }
        } catch (err) {
          logger.error(`${label}消息处理失败，重新投递回主队列`, { err });
          if (requeueOnError) {
            // 先回主队列再清理 processing；若清理失败，sweeper 会再次重投（at-least-once）。
            try {
              await redis.rpush(opts.queueName, rawJson);
              await redis.lrem(processingQueue, 1, rawJson);
            } catch (requeueErr) {
              logger.error(`${label}重投失败，等待 sweeper 兜底`, {
                err: requeueErr,
              });
            }
          } else {
            await redis.lrem(processingQueue, 1, rawJson).catch(() => {});
          }
          // 避免 DB/Redis 持续故障时 hot loop
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (err) {
        if (state.requested) break;
        logger.error(`${label}消费者错误`, { err });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    opts.aliveRef.value = false;
    await redis.disconnect().catch(() => {});
  }
}
