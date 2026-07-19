import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { submissions } from "../db/schema.ts";
import { createConsumerRedis } from "./connection.ts";
import { logger } from "../lib/logging.ts";

const STARTED_QUEUE = "noj:judge:started";

const BLPOP_TIMEOUT = 10;

const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

export let startedConsumerAlive = false;

export async function startStartedConsumerWithRetry(): Promise<void> {
  let retryCount = 0;

  while (true) {
    startedConsumerAlive = false;

    logger.info("评测开始事件消费者正在启动...");

    try {
      await startStartedConsumer();
    } catch (err) {
      logger.error("评测开始事件消费者异常退出", { err });
    }

    startedConsumerAlive = false;

    const delay = Math.min(
      INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount),
      MAX_RETRY_DELAY_MS,
    );
    retryCount++;

    logger.warn("评测开始事件消费者将重启", {
      delay_ms: delay,
      retry: retryCount,
    });

    await new Promise((r) => setTimeout(r, delay));
  }
}

async function startStartedConsumer(): Promise<void> {
  const redis = createConsumerRedis();

  try {
    await redis.connect();
  } catch (err) {
    logger.error("评测开始事件消费者 Redis 连接失败", { err });
    return;
  }

  startedConsumerAlive = true;
  logger.info("评测开始事件消费者启动，等待事件...");

  while (true) {
    try {
      const result = await redis.brpop(
        STARTED_QUEUE,
        BLPOP_TIMEOUT,
      ) as [string, string] | null;

      if (!result) {
        continue;
      }

      if (!Array.isArray(result) || result.length < 2) {
        logger.error("评测开始事件 brpop 返回格式异常，跳过");
        continue;
      }

      const [, rawJson] = result;

      let message: { submission_id?: string };
      try {
        message = JSON.parse(rawJson);
      } catch {
        logger.error("评测开始事件 JSON 解析失败，跳过");
        continue;
      }

      if (!message.submission_id) {
        logger.error("评测开始事件缺少 submission_id，跳过");
        continue;
      }

      const now = new Date().toISOString();
      const db = getDb();
      await db
        .update(submissions)
        .set({ judge_started_at: now })
        .where(
          and(
            eq(submissions.id, message.submission_id),
            sql`${submissions.judge_started_at} IS NULL`,
          ),
        );

      logger.info("评测开始时间已更新", {
        submission_id: message.submission_id,
        started_at: now,
      });
    } catch (err) {
      logger.error("评测开始事件消费者错误", { err });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
