import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { submissions } from "../db/schema.ts";
import { createConsumerRedis } from "./connection.ts";

const STARTED_QUEUE = "noj:judge:started";

const BLPOP_TIMEOUT = 10;

const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

export let startedConsumerAlive = false;

export async function startStartedConsumerWithRetry(): Promise<void> {
  let retryCount = 0;

  while (true) {
    startedConsumerAlive = false;

    console.log("评测开始事件消费者正在启动...");

    try {
      await startStartedConsumer();
    } catch (err) {
      console.error(
        "评测开始事件消费者异常退出:",
        err instanceof Error ? err.message : String(err),
      );
    }

    startedConsumerAlive = false;

    const delay = Math.min(
      INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount),
      MAX_RETRY_DELAY_MS,
    );
    retryCount++;

    console.warn(
      `评测开始事件消费者将在 ${delay}ms 后重启（重试 #${retryCount}）...`,
    );

    await new Promise((r) => setTimeout(r, delay));
  }
}

async function startStartedConsumer(): Promise<void> {
  const redis = createConsumerRedis();

  try {
    await redis.connect();
  } catch (err) {
    console.error(
      "评测开始事件消费者 Redis 连接失败:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  startedConsumerAlive = true;
  console.log("评测开始事件消费者启动，等待事件...");

  // @ts-ignore - ioredis 的 brpop 类型在 Deno 中解析受限
  while (true) {
    try {
      const result: [string, string] | null = await redis.brpop(
        STARTED_QUEUE,
        BLPOP_TIMEOUT,
      );

      if (!result) {
        continue;
      }

      const [, rawJson] = result;

      let message: { submission_id?: string };
      try {
        message = JSON.parse(rawJson);
      } catch {
        console.error("评测开始事件 JSON 解析失败，跳过");
        continue;
      }

      if (!message.submission_id) {
        console.error("评测开始事件缺少 submission_id，跳过");
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

      console.log(
        `评测开始时间已更新: submission=${message.submission_id}, started_at=${now}`,
      );
    } catch (err) {
      console.error(
        "评测开始事件消费者错误:",
        err instanceof Error ? err.message : String(err),
      );
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
