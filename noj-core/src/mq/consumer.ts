import { createConsumer } from "./base-consumer.ts";
import { saveEvaluationResult } from "../services/submissions.ts";
import { logger, logJudgeResultReceived } from "../lib/logging.ts";
import { Channels, publishEvent } from "../lib/event-bus.ts";
import type { JudgeResult } from "../types/index.ts";

/**
 * 评测结果队列名称。
 * noj-judge 将评测结果 LPUSH 到此列表，消费者通过 BRPOP 阻塞读取。
 */
const RESULT_QUEUE = "noj:judge:results";

/**
 * 消费者活跃状态标识。
 * 供健康检查端点查询消费者是否在正常运行。
 */
export const consumerAlive = { value: false };

async function handleResultMessage(
  data: Record<string, unknown>,
): Promise<void> {
  const judgeResult = data as unknown as JudgeResult;

  if (!judgeResult.submission_id) {
    logger.error("评测结果缺少 submission_id，跳过");
    return;
  }

  logJudgeResultReceived(
    judgeResult.submission_id,
    judgeResult.status,
    judgeResult.score,
  );

  try {
    await saveEvaluationResult(judgeResult);
    logger.info("评测结果已持久化", {
      submission_id: judgeResult.submission_id,
    });

    // 发布事件到 Redis Pub/Sub（fire-and-forget，不阻塞）
    // 事件仅作触发通知，前端收到后主动通过 REST 接口拉取全量数据
    publishEvent(
      Channels.submission(judgeResult.submission_id),
      JSON.stringify({
        type: "submission:updated",
        id: judgeResult.submission_id,
      }),
    );
    publishEvent(
      Channels.queue,
      JSON.stringify({ type: "queue:changed" }),
    );
  } catch (dbErr) {
    logger.error("评测结果持久化失败", {
      submission_id: judgeResult.submission_id,
      err: dbErr,
    });
    // 不中断循环，错误仅记录日志
  }
}

/**
 * 启动评测结果消费者（带自动重连）。
 *
 * 在内部因 Redis 断开等原因退出时，
 * 使用指数退避策略自动创建新连接并重新启动消费。
 * 此函数不会正常返回——它会持续尝试重连。
 */
export const startResultConsumerWithRetry = createConsumer({
  queueName: RESULT_QUEUE,
  logLabel: "结果",
  aliveRef: consumerAlive,
  handleMessage: handleResultMessage,
});
