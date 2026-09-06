import {
  type ConsumerOptions,
  createConsumer,
  requestConsumerShutdown,
} from "../../../shared/mq/base-consumer.ts";
import { saveEvaluationResult } from "../services/submissions/submissions-result.ts";
import { saveSelfTestResult } from "../services/self-tests.ts";
import {
  logger,
  logJudgeResultReceived,
} from "../../../shared/base/logging.ts";
import {
  Channels,
  publishSseEvent,
  publishSseEventAfterTx,
} from "../../../shared/sse/event-bus.ts";
import { SELF_TEST_ID_PREFIX } from "../types/self-tests.ts";
import type { JudgeResult } from "../types/index.ts";
import { metrics } from "../../../shared/base/metrics.ts";

/**
 * 评测结果队列名称。
 * noj-judge 将评测结果 LPUSH 到此列表，消费者通过 BRPOP 阻塞读取。
 */
export const RESULT_QUEUE = "noj:judge:results";

/** 结果消费者默认并发连接数。 */
export const DEFAULT_RESULT_CONSUMER_CONCURRENCY = 4;
/** 结果消费者并发连接数上限，避免误配置耗尽 Redis/数据库连接。 */
export const MAX_RESULT_CONSUMER_CONCURRENCY = 16;

/** judge details 允许的顶层键（按当前 evaluate.py 契约白名单化）。 */
const JUDGE_DETAIL_ALLOWED_KEYS = new Set([
  "cases",
  "score",
  "score_content",
  "score_format",
  "hidden_provided",
  "summary",
]);

/** 单个用例对象允许的键。 */
const JUDGE_CASE_ALLOWED_KEYS = new Set([
  "case_id",
  "status",
  "visibility",
  "time_ms",
  "input",
  "expected_output",
  "actual_output",
]);

/** 单个值序列化后的最大字节数，超出即丢弃（防超大恶意字段）。 */
const MAX_DETAIL_VALUE_BYTES = 64 * 1024;

/**
 * judge 结果 details 白名单化（F-11）。
 *
 * 仅保留安全键；每条用例只保留白名单字段；任一值超过 64KB 丢弃。
 */
export function sanitizeJudgeDetails(
  details: Record<string, unknown>,
): Record<string, unknown> {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!JUDGE_DETAIL_ALLOWED_KEYS.has(key)) continue;
    const normalized = key === "cases" && Array.isArray(value)
      ? value.map(sanitizeCase)
      : value;
    const serialized = JSON.stringify(normalized);
    if (
      serialized !== undefined && serialized.length > MAX_DETAIL_VALUE_BYTES
    ) {
      continue;
    }
    result[key] = normalized;
  }
  return result;
}

function sanitizeCase(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const caseObj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(caseObj)) {
    if (JUDGE_CASE_ALLOWED_KEYS.has(key)) result[key] = field;
  }
  return result;
}

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

  // F-11：落库前白名单化 details（未知 key / 超大值一律丢弃）。
  judgeResult.details = sanitizeJudgeDetails(judgeResult.details ?? {});

  metrics.inc("noj_evaluation_results_total");

  logJudgeResultReceived(
    judgeResult.submission_id,
    judgeResult.status,
    judgeResult.score,
  );

  const isSelfTest = judgeResult.submission_id.startsWith(SELF_TEST_ID_PREFIX);

  // NOJ-074：写库失败必须向上抛出让消费者重投，
  // 不再吞掉错误导致提交永久停留在 judging。
  try {
    if (isSelfTest) {
      const applied = await saveSelfTestResult(judgeResult);
      if (!applied) {
        logger.info("重复/过时自测结果，已幂等忽略", {
          self_test_id: judgeResult.submission_id,
          rejudge_seq: judgeResult.rejudge_seq ?? 0,
        });
        return;
      }
      logger.info("自测结果已持久化", {
        self_test_id: judgeResult.submission_id,
      });
      // 自测：保持原有轻量事件（自测不参与榜单/竞赛，队列事件允许轮询兜底）。
      await publishSseEvent(
        Channels.queue,
        { type: "queue:changed" },
      );
      return;
    }

    const applied = await saveEvaluationResult(judgeResult);
    if (!applied.applied) {
      logger.info("评测结果为重复/过时消息，已幂等忽略", {
        submission_id: judgeResult.submission_id,
        rejudge_seq: judgeResult.rejudge_seq ?? 0,
      });
      return;
    }

    logger.info("评测结果已持久化", {
      submission_id: judgeResult.submission_id,
      kind: "submission",
    });

    // 正式提交：评测结果相关事件已在业务事务内写入 sse_events（事务性 Outbox），
    // 这里只发布 Redis 实时通知，不再重复写库。
    for (const event of applied.outbox_events) {
      publishSseEventAfterTx(event.channel, event.payload, event.event_id);
    }

    // 队列变化通知（全局刷新类，允许轮询兜底；不要求与业务同事务）
    await publishSseEvent(
      Channels.queue,
      { type: "queue:changed" },
    );
  } catch (err) {
    metrics.inc("noj_evaluation_consumer_errors_total");
    throw err;
  }
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
