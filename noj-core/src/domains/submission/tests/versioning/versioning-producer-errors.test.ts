/**
 * 入队失败分类回归（tracking #38）。
 *
 * §5.7 要求明确区分**容量 / 网络 / 永久**错误：容量不足等待下轮、网络失败指数
 * 退避、永久错误立即终态。此前 `producer.ts` 只按消息字符串排除"超过大小限制"，
 * 派发侧又把所有可重试错误一律当成"队列已满"，网络失败因此既不退避也不计次。
 *
 * 覆盖：`JudgeQueueError.kind` 的显式分类、历史/外部 `Error` 的消息兜底分类、
 * `isRetryableJudgeQueueError` 的兼容语义，以及 `pushJudgeTask` 在真实容量
 * 耗尽时抛出的分类错误。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  classifyJudgeQueueError,
  isRetryableJudgeQueueError,
  JUDGE_QUEUE_CAPACITY,
  JudgeQueueError,
  pushJudgeTask,
} from "../../mq/producer.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { startFakeRedis } from "../mq/_setup.ts";
import type { JudgeTask } from "../../index.ts";

Deno.test("producer#38: 显式分类 capacity / network / permanent", () => {
  assertEquals(
    classifyJudgeQueueError(new JudgeQueueError("capacity", "满")),
    "capacity",
  );
  assertEquals(
    classifyJudgeQueueError(new JudgeQueueError("network", "断")),
    "network",
  );
  assertEquals(
    classifyJudgeQueueError(new JudgeQueueError("permanent", "大")),
    "permanent",
  );
});

Deno.test("producer#38: 非结构化错误按消息兜底分类（兼容既有调用方与夹具）", () => {
  // 容量
  assertEquals(
    classifyJudgeQueueError(new Error("评测队列已满（100/100），请稍后重试")),
    "capacity",
  );
  // 永久错误：消息过大、队列布局需要协调升级
  assertEquals(
    classifyJudgeQueueError(
      new Error("评测任务消息超过大小限制（20000000 > 16777216 字节）"),
    ),
    "permanent",
  );
  assertEquals(
    classifyJudgeQueueError(
      new Error("评测队列已升级为资源池布局，请协调升级 Core 配置后重试"),
    ),
    "permanent",
  );
  // 网络 / 未知一律可恢复，避免把瞬时故障误判为永久失败
  assertEquals(
    classifyJudgeQueueError(new Error("connect ECONNREFUSED 127.0.0.1:6379")),
    "network",
  );
  assertEquals(classifyJudgeQueueError("boom"), "network");
  assertEquals(classifyJudgeQueueError(undefined), "network");
});

Deno.test("producer#38: isRetryableJudgeQueueError 仅永久错误不可重试", () => {
  assertEquals(
    isRetryableJudgeQueueError(new JudgeQueueError("capacity", "满")),
    true,
  );
  assertEquals(
    isRetryableJudgeQueueError(new JudgeQueueError("network", "断")),
    true,
  );
  assertEquals(
    isRetryableJudgeQueueError(new JudgeQueueError("permanent", "大")),
    false,
  );
  assertEquals(
    isRetryableJudgeQueueError(new Error("消息超过大小限制")),
    false,
  );
  assertEquals(
    isRetryableJudgeQueueError(new Error("评测队列已满")),
    true,
  );
});

Deno.test({
  name: "producer#38: 容量耗尽时抛出 capacity 分类错误（可等待，不退避）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const previousRedisUrl = Deno.env.get("REDIS_URL");
    const fake = startFakeRedis();
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      const redis = getRedis();
      await redis.connect();
      await redis.ping();
      fake.seedQueue("noj:judge:queue:ai:high", JUDGE_QUEUE_CAPACITY.high);

      const task: JudgeTask = {
        scheduling_version: 1,
        resource_pool: "ai",
        submission_id: "capacity-sub",
        problem_id: "1001",
        user_id: "u1",
        runtime_config: {
          evaluator: {
            image: "e",
            command: "c",
            time_limit_ms: 1000,
            memory_limit_mb: 128,
          },
          solution: {
            image: "s",
            call_timeout_ms: 1000,
            memory_limit_mb: 128,
          },
        },
        download_url: "noj-download://base64/?content=",
        language: "python3",
        code: "print(1)",
        priority: "high",
        judge_type: "dual",
      } as JudgeTask;

      const error = await assertRejects(() => pushJudgeTask(task));
      assertEquals(error instanceof JudgeQueueError, true);
      assertEquals(classifyJudgeQueueError(error), "capacity");
      // 队列未被写入（仍只有预置的容量占位消息）
      assertEquals(
        fake.getMessages("noj:judge:queue:ai:high").length,
        JUDGE_QUEUE_CAPACITY.high,
      );
    } finally {
      resetRedisForTest();
      if (previousRedisUrl === undefined) Deno.env.delete("REDIS_URL");
      else Deno.env.set("REDIS_URL", previousRedisUrl);
      await fake.stop();
    }
  },
});

Deno.test({
  name: "producer#38: Redis 未就绪时抛出 network 分类错误",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetRedisForTest();
    // 未 connect：status !== "ready"
    const error = await assertRejects(() =>
      pushJudgeTask({
        scheduling_version: 1,
        resource_pool: "ai",
        submission_id: "not-ready-sub",
        problem_id: "1001",
        user_id: "u1",
        runtime_config: {
          evaluator: {
            image: "e",
            command: "c",
            time_limit_ms: 1000,
            memory_limit_mb: 128,
          },
          solution: {
            image: "s",
            call_timeout_ms: 1000,
            memory_limit_mb: 128,
          },
        },
        download_url: "noj-download://base64/?content=",
        language: "python3",
        code: "print(1)",
        priority: "medium",
        judge_type: "dual",
      } as JudgeTask)
    );
    assertEquals(classifyJudgeQueueError(error), "network");
    assertEquals(isRetryableJudgeQueueError(error), true);
  },
});
