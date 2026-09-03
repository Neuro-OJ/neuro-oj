import { createConsumerRedis } from "./connection.ts";
import { logger } from "./../shared/base/logging.ts";

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
}

const DEFAULT_BLPOP_TIMEOUT = 10;
const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

let consumerShutdownRequested = false;

/** 优雅关闭时请求结果消费者退出（BRPOPLPUSH 使未确认消息仍在 processing 列表）。 */
export function requestConsumerShutdown(): void {
  consumerShutdownRequested = true;
}

/** 测试用：复位关闭标记。 */
export function _resetConsumerShutdownForTest(): void {
  consumerShutdownRequested = false;
}

/**
 * Create a consumer with automatic reconnection using exponential backoff.
 *
 * 可靠消费语义（NOJ-066/NOJ-074/NOJ-179）：
 * - BRPOPLPUSH 先把消息移入 processing 列表，处理成功后 LREM 确认；
 * - 处理抛错立即 RPUSH 回主队列并移除 processing 条目；
 * - 崩溃时消息留在 processing，由 sweeper 超时扫描重投。
 *
 * @returns A function that starts the consumer (does not return normally).
 */
export function createConsumer(opts: ConsumerOptions): () => Promise<void> {
  const blpopTimeout = opts.blpopTimeout ?? DEFAULT_BLPOP_TIMEOUT;
  const label = opts.logLabel;
  const processingQueue = `${opts.queueName}:processing`;
  const requeueOnError = opts.requeueOnError ?? true;

  return async function startConsumerWithRetry(): Promise<void> {
    let retryCount = 0;

    while (!consumerShutdownRequested) {
      opts.aliveRef.value = false;

      logger.info(`${label}消费者正在启动...`);

      try {
        await runConsumer();
      } catch (err) {
        logger.error(`${label}消费者异常退出`, { err });
      }

      opts.aliveRef.value = false;
      if (consumerShutdownRequested) break;

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
  };

  async function runConsumer(): Promise<void> {
    const redis = createConsumerRedis();
    try {
      await redis.connect();
    } catch (err) {
      logger.error(`${label}消费者 Redis 连接失败`, { err });
      await redis.disconnect();
      return;
    }

    opts.aliveRef.value = true;
    logger.info(`${label}消费者启动，等待事件...`);

    while (!consumerShutdownRequested) {
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
        if (consumerShutdownRequested) break;
        logger.error(`${label}消费者错误`, { err });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    opts.aliveRef.value = false;
    await redis.disconnect().catch(() => {});
  }
}
