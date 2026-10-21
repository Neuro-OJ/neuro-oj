import { publishQueueChange } from "../services/queue.ts";
import {
  projectMeteringDetails,
  projectOiDetails,
  projectOiSelfTestDetails,
} from "../services/submissions/oi-details.ts";
import {
  type ConsumerHandle,
  type ConsumerOptions,
  createConsumer,
  requestConsumerShutdown,
} from "../../../shared/mq/base-consumer.ts";
import type { ManagedTask } from "../../../shared/runtime/managed-task.ts";
import { saveEvaluationResultCommand } from "../../application/evaluations.ts";
import { saveSelfTestResult } from "../services/self-tests.ts";
import { getLogger } from "@logtape/logtape";
import { publishSseEventAfterTx } from "../../../shared/sse/event-bus.ts";
import { SELF_TEST_ID_PREFIX } from "../types/self-tests.ts";
import type { JudgeResult } from "../types/index.ts";
import { observability as metrics } from "../../platform/observability/write.ts";

const logger = getLogger(["noj", "submission"]);
import { saveOiProgress } from "../services/oi-progress.ts";

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
  "run_id",
  "oi",
  "metering",
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
  "hidden",
  "time_ms",
  // 用例级内存（KB）。此前缺失导致 `details.cases[].memory_kb` 在落库前
  // 被静默丢弃，与 Evaluator SDK 文档契约不符（2026-09-24 审计 A2-1）。
  "memory_kb",
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
  selfTest = false,
): Record<string, unknown> {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!JUDGE_DETAIL_ALLOWED_KEYS.has(key)) continue;
    const normalized = key === "oi"
      ? (selfTest ? projectOiSelfTestDetails(value) : projectOiDetails(value))
      : key === "metering"
      ? projectMeteringDetails(value)
      : key === "cases" && Array.isArray(value)
      ? value.map(sanitizeCase)
      : value;
    const serialized = JSON.stringify(normalized);
    if (
      serialized !== undefined &&
      serialized.length >
        (selfTest && key === "oi" ? 4 * 1024 * 1024 : MAX_DETAIL_VALUE_BYTES)
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

/** 可停止的消费者工厂（P2a 结果池使用，返回带 requestShutdown 的句柄）。 */
export type ManagedResultConsumerFactory = (
  options: ConsumerOptions,
) => ConsumerHandle;

/** 结果消费者池启动选项（`consumerFactory` 仅供测试注入）。 */
export interface ResultConsumerPoolOptions {
  concurrency?: number;
  consumerFactory?: ManagedResultConsumerFactory;
}

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

/**
 * 处理一条结果队列消息（**不可信输入**）。
 *
 * 参数类型是 `unknown` 而非 `Record<string, unknown>`：Redis 队列是信任边界，
 * 消息可能是任意 JSON（字符串、数组、null）。同时 `JudgeResult` 是 interface，
 * 没有隐式索引签名，把他声明成 `Record<string, unknown>` 会让调用方无法直接
 * 传入一个结构化结果（TS2345）。这里显式做形状收窄。
 */
export async function handleResultMessage(data: unknown): Promise<void> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    logger.error("评测结果消息格式非法，跳过", { kind: typeof data });
    return;
  }
  const record = data as Record<string, unknown>;
  if (record.kind === "oi_progress") {
    await saveOiProgress(record);
    return;
  }
  const judgeResult = record as unknown as JudgeResult;

  if (!judgeResult.submission_id) {
    logger.error("评测结果缺少 submission_id，跳过");
    return;
  }

  // F-11：落库前白名单化 details（未知 key / 超大值一律丢弃）。
  judgeResult.details = sanitizeJudgeDetails(
    judgeResult.details ?? {},
    judgeResult.submission_id.startsWith(SELF_TEST_ID_PREFIX),
  );

  metrics.inc("noj_evaluation_results_total");

  logger.info("收到评测结果", {
    submission_id: judgeResult.submission_id,
    status: judgeResult.status,
    score: judgeResult.score,
  });

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
      await publishQueueChange(judgeResult.submission_id);
      return;
    }

    const applied = await saveEvaluationResultCommand(
      { kind: "system", purpose: "background_task" },
      judgeResult,
    );
    if (!applied.applied) {
      logger.info("评测结果为重复/过时消息，已幂等忽略", {
        submission_id: judgeResult.submission_id,
        rejudge_seq: judgeResult.rejudge_seq ?? 0,
      });
      return;
    }

    // 首次评测结果：记录从提交创建到结果落库的端到端延迟。
    if (applied.created_at && !applied.is_rejudge) {
      const startedMs = Date.parse(applied.created_at);
      if (Number.isFinite(startedMs)) {
        metrics.observe(
          "noj_submission_e2e_duration_seconds",
          Math.max(0, (Date.now() - startedMs) / 1000),
          { result: judgeResult.status },
        );
      }
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
    await publishQueueChange(judgeResult.submission_id);
  } catch (err) {
    metrics.inc("noj_evaluation_consumer_errors_total");
    throw err;
  }
}

/**
 * 启动结果消费者池并返回统一后台任务句柄（P2a）。
 *
 * 每个消费者使用独立 Redis 连接，但共享同一 processing 列表；Redis 的
 * BRPOPLPUSH 保证一条消息只会被一个连接领取。单条消息仍按原有顺序完成
 * “持久化 → LREM 确认”，因此不会改变 at-least-once 与幂等语义。
 *
 * `done` 在全部并发消费者退出后 resolve——关闭流程据此等待在途结果落库，
 * 再关闭数据库连接。
 *
 * @returns 可停止、可等待的消费者池句柄
 */
export function startResultConsumerPool(
  options: ResultConsumerPoolOptions = {},
): ManagedTask {
  const concurrency = options.concurrency ?? parseResultConsumerConcurrency();
  const consumerFactory = options.consumerFactory ?? createConsumer;
  logger.info("评测结果消费者池已配置", { concurrency });
  // 每个消费者独立 aliveRef，汇总为"任一副本仍存活即健康"；否则单个消费者
  // 退出会把整个池误报为不可用。
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
  const handles = aliveRefs.map((aliveRef) =>
    consumerFactory({
      queueName: RESULT_QUEUE,
      logLabel: "评测结果",
      aliveRef,
      handleMessage: handleResultMessage,
      requeueOnError: true,
    })
  );
  // 关键：用 allSettled 等待**全部**消费者退出。Promise.all 会在任一连接失败时
  // 提前 reject，此时其他消费者仍可能正在处理消息，done 却已 resolve。
  const started = (async () => {
    const results = await Promise.allSettled(handles.map((start) => start()));
    const failures = results
      .filter((result): result is PromiseRejectedResult =>
        result.status === "rejected"
      )
      .map((result) => result.reason);
    if (failures.length > 0) {
      const detail = failures
        .map((reason) =>
          reason instanceof Error ? reason.message : String(reason)
        )
        .join("; ");
      throw new AggregateError(
        failures,
        `评测结果消费者池有 ${failures.length} 个实例异常退出：${detail}`,
      );
    }
  })();
  // 先挂 no-op handler 防止早期无人 await 时触发 unhandledRejection；
  // done 仍保留原拒绝供任务组汇总。
  started.catch(() => {});
  return {
    name: "result-consumer-pool",
    stop: () => {
      for (const handle of handles) handle.requestShutdown();
    },
    done: started,
  };
}

/**
 * 启动结果消费者池（阻塞式旧入口，保留给既有调用方）。
 *
 * @deprecated 新代码用 {@link startResultConsumerPool} 获取可停止、可等待的句柄；
 * 本函数不返回句柄，关闭流程无法等待在途结果处理完成。
 */
export async function startResultConsumerWithRetry(): Promise<void> {
  const concurrency = parseResultConsumerConcurrency();
  logger.info("评测结果消费者池已配置", { concurrency });
  await createResultConsumerPool(concurrency)();
}

export { requestConsumerShutdown as requestResultConsumerShutdown };
