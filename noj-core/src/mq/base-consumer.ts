import { createConsumerRedis } from "./connection.ts";
import { logger } from "../lib/logging.ts";

export interface ConsumerOptions {
  queueName: string;
  logLabel: string; // e.g. "结果", "评测开始事件"
  aliveRef: { value: boolean };
  handleMessage: (data: Record<string, unknown>) => Promise<void>;
  /** BLPOP timeout in seconds */
  blpopTimeout?: number;
}

const DEFAULT_BLPOP_TIMEOUT = 10;
const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Create a consumer with automatic reconnection using exponential backoff.
 *
 * @returns A function that starts the consumer (does not return normally).
 */
export function createConsumer(opts: ConsumerOptions): () => Promise<void> {
  const blpopTimeout = opts.blpopTimeout ?? DEFAULT_BLPOP_TIMEOUT;
  const label = opts.logLabel;

  return async function startConsumerWithRetry(): Promise<void> {
    let retryCount = 0;

    while (true) {
      opts.aliveRef.value = false;

      logger.info(`${label}消费者正在启动...`);

      try {
        await runConsumer();
      } catch (err) {
        logger.error(`${label}消费者异常退出`, { err });
      }

      opts.aliveRef.value = false;

      const delay = Math.min(
        INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount),
        MAX_RETRY_DELAY_MS,
      );
      retryCount++;

      logger.warn(`${label}消费者将重启`, { delay_ms: delay, retry: retryCount });
      await new Promise((r) => setTimeout(r, delay));
    }
  };

  async function runConsumer(): Promise<void> {
    const redis = createConsumerRedis();
    try {
      await redis.connect();
    } catch (err) {
      logger.error(`${label}消费者 Redis 连接失败`, { err });
      redis.disconnect();
      return;
    }

    opts.aliveRef.value = true;
    logger.info(`${label}消费者启动，等待事件...`);

    while (true) {
      try {
        // deno-lint-ignore no-explicit-any
        const result = await redis.brpop(opts.queueName, blpopTimeout) as [string, string] | null;
        if (!result) continue;

        if (!Array.isArray(result) || result.length < 2) {
          logger.error(`${label} brpop 返回格式异常，跳过`);
          continue;
        }

        const [, rawJson] = result;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(rawJson);
        } catch {
          logger.error(`${label} JSON 解析失败，跳过`);
          continue;
        }

        await opts.handleMessage(message);
      } catch (err) {
        logger.error(`${label}消费者错误`, { err });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}
