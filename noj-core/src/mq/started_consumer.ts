import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { submissions } from "../db/schema.ts";
import { createConsumer } from "./base-consumer.ts";
import { logger } from "../lib/logging.ts";

const STARTED_QUEUE = "noj:judge:started";

export const startedConsumerAlive = { value: false };

async function handleStartedMessage(
  data: Record<string, unknown>,
): Promise<void> {
  const message = data as { submission_id?: string };

  if (!message.submission_id) {
    logger.error("评测开始事件缺少 submission_id，跳过");
    return;
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
}

export const startStartedConsumerWithRetry = createConsumer({
  queueName: STARTED_QUEUE,
  logLabel: "评测开始事件",
  aliveRef: startedConsumerAlive,
  handleMessage: handleStartedMessage,
});
