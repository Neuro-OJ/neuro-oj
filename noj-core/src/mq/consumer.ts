import {
  type ConsumerOptions,
  createConsumer,
  requestConsumerShutdown,
} from "./base-consumer.ts";
import { saveEvaluationResult } from "../services/submissions/submissions.ts";
import { saveSelfTestResult } from "../services/self-tests.ts";
import { logger, logJudgeResultReceived } from "../lib/logging.ts";
import { Channels, publishEvent } from "../lib/event-bus.ts";
import { SELF_TEST_ID_PREFIX } from "../types/self-tests.ts";
import type { JudgeResult } from "../types/index.ts";

/**
 * 评测结果队列名称。
 * noj-judge 将评测结果 LPUSH 到此列表，消费者通过 BRPOP 阻塞读取。
 */
export const RESULT_QUEUE = "noj:judge:results";

/** 结果消费者默认并发连接数。 */
export const DEFAULT_RESULT_CONSUMER_CONCURRENCY = 4;
/** 结果消费者并发连接数上限，避免误配置耗尽 Redis/数据库连接。 */
export const MAX_RESULT_CONSUMER_CONCURRENCY = 16;

/**
 * 解析结果消费者并发配置。
 * 非正整数、超出上限或无法解析时回退到安全默认值。
 */
export function parseResultConsumerConcurrency(
  raw: string | undefined = Deno.env.get("RESULT_CONSUMER_CONCURRENCY"),
): number {
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(value) && value >= 1 &&
      value <= MAX_RESULT_CONSUMER_CONCURRENCY
    ? value
    : DEFAULT_RESULT_CONSUMER_CONCURRENCY;
}

/**
 * 消费者活跃状态标识。
 * 供健康检查端点查询消费者是否在正常运行。
 */
export const consumerAlive = { value: false };

/** 结果消费者工厂，测试可注入以验证消费者池的编排行为。 */
export type ResultConsumerFactory = (
  options: ConsumerOptions,
) => () => Promise<void>;

/**
 * 创建结果消费者池。
 *
 * 每个消费者共享同一个健康状态汇总，但各自持有独立的 aliveRef；只要有一个
 * 消费者仍在运行，consumerAlive 就保持为 true。
 */
export function createResultConsumerPool(
  concurrency: number,
  consumerFactory: ResultConsumerFactory = createConsumer,
): () => Promise<void> {
  const states = Array.from({ length: concurrency }, () => false);
  consumerAlive.value = false;
  const aliveRefs = states.map((_, index) => ({
    get value(): boolean {
      return states[index] ?? false;
    },
    set value(value: boolean) {
      states[index] = value;
      consumerAlive.value = states.some(Boolean);
    },
  }));

  const consumers = aliveRefs.map((aliveRef, index) =>
    consumerFactory({
      queueName: RESULT_QUEUE,
      logLabel: `结果-${index + 1}/${concurrency}`,
      aliveRef,
      handleMessage: handleResultMessage,
      requeueOnError: true,
    })
  );

  return async () => {
    await Promise.all(consumers.map((start) => start()));
  };
}

export async function handleResultMessage(
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

  const isSelfTest = judgeResult.submission_id.startsWith(SELF_TEST_ID_PREFIX);

  // NOJ-074：写库失败必须向上抛出让消费者重投，
  // 不再吞掉错误导致提交永久停留在 judging。
  const applied = isSelfTest
    ? await saveSelfTestResult(judgeResult)
    : await saveEvaluationResult(judgeResult);
  if (!applied) {
    logger.info("评测结果为重复/过时消息，已幂等忽略", {
      submission_id: judgeResult.submission_id,
      rejudge_seq: judgeResult.rejudge_seq ?? 0,
    });
    return;
  }

  logger.info("评测结果已持久化", {
    submission_id: judgeResult.submission_id,
    kind: isSelfTest ? "self_test" : "submission",
  });

  // 发布事件到 Redis Pub/Sub（fire-and-forget，不阻塞）
  // 事件仅作触发通知，前端收到后主动通过 REST 接口拉取全量数据
  if (!isSelfTest) {
    publishEvent(
      Channels.submission(judgeResult.submission_id),
      JSON.stringify({
        type: "submission:updated",
        id: judgeResult.submission_id,
      }),
    );
  }
  publishEvent(
    Channels.queue,
    JSON.stringify({ type: "queue:changed" }),
  );
}

/**
 * 启动结果消费者池。
 *
 * 每个消费者使用独立 Redis 连接，但共享同一 processing 列表；Redis 的
 * BRPOPLPUSH 保证一条消息只会被一个连接领取。单条消息仍按原有顺序完成
 * “持久化 → LREM 确认”，因此不会改变 at-least-once 与幂等语义。
 */
export async function startResultConsumerWithRetry(): Promise<void> {
  const concurrency = parseResultConsumerConcurrency();
  logger.info("评测结果消费者池已配置", { concurrency });
  await createResultConsumerPool(concurrency)();
}

export { requestConsumerShutdown as requestResultConsumerShutdown };
