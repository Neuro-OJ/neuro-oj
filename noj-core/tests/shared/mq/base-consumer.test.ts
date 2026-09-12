/**
 * 消费者基类可靠性测试（2026-09-12 架构评审 §2.5）。
 *
 * 覆盖两个此前缺失的保障：
 * 1. `:processing` 残留消息在启动时重投（此前只有评测结果队列有 sweeper 兜底，
 *    `noj:search:index` / `noj:review:dm` 的消息会永久滞留）；
 * 2. 关闭标记是**每实例独立**的（此前三个消费者共享一个模块级布尔量，
 *    停一个会连带停掉全部）。
 *
 * 需要 Redis：不可用时记录 WARN 并跳过（不静默，见 `dev-docs/engineering/`）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  _resetConsumerShutdownForTest,
  createConsumer,
  requeueStaleProcessing,
} from "../../../src/shared/mq/base-consumer.ts";
import {
  createConsumerRedis,
  type RedisClient,
} from "../../../src/shared/mq/connection.ts";
import { listSweepTargets } from "../../../src/shared/mq/sweep-targets.ts";

/** 尝试建立 Redis 连接；失败返回 null（并由调用方 WARN，不静默通过） */
async function connectRedisOrNull(): Promise<RedisClient | null> {
  const redis = createConsumerRedis();
  try {
    await redis.connect();
    await redis.ping();
    return redis;
  } catch {
    await redis.disconnect().catch(() => {});
    return null;
  }
}

const RUN_ID = Date.now();

Deno.test("base-consumer: createConsumer 自动登记 sweeper 兜底目标", () => {
  _resetConsumerShutdownForTest();
  const queueName = `noj:test:sweeptarget:${RUN_ID}`;
  const handle = createConsumer({
    queueName,
    logLabel: "测试",
    aliveRef: { value: false },
    handleMessage: () => Promise.resolve(),
  });
  try {
    const target = listSweepTargets().find((t) => t.queueName === queueName);
    assertEquals(
      target !== undefined,
      true,
      "createConsumer 必须自动登记 sweeper 兜底目标（新增消费者无需改 sweeper 清单）",
    );
    // 未声明时使用默认超时（15 分钟）
    assertEquals(target?.processingTimeoutMs, 15 * 60_000);
  } finally {
    handle.requestShutdown();
    _resetConsumerShutdownForTest();
  }
});

Deno.test("base-consumer: processing 残留消息启动时重投（每进程每队列一次）", async () => {
  const redis = await connectRedisOrNull();
  if (!redis) {
    console.warn(
      "[warn] 未检测到可用 Redis，跳过 processing 重投测试（CI 与本地开发环境应提供 Redis）",
    );
    return;
  }
  const queueName = `noj:test:requeue:${RUN_ID}`;
  const processingQueue = `${queueName}:processing`;
  try {
    _resetConsumerShutdownForTest();
    await redis.del(queueName, processingQueue);
    // 用 LPUSH 模拟 BRPOPLPUSH 的写入侧：最早未确认的（seq=1）在 processing 尾部
    await redis.lpush(processingQueue, '{"seq":1}');
    await redis.lpush(processingQueue, '{"seq":2}');

    const moved = await requeueStaleProcessing(
      redis,
      queueName,
      processingQueue,
      "测试",
    );
    assertEquals(moved, 2, "两条残留消息都应被重投");
    assertEquals(await redis.llen(processingQueue), 0);
    assertEquals(await redis.llen(queueName), 2);
    // 顺序保留：最早未确认的（seq=1）应在主队列尾部（最先被消费者取走）
    const drained = await redis.lrange(queueName, 0, -1);
    assertEquals(drained, ['{"seq":2}', '{"seq":1}']);

    // 第二次调用为 no-op：避免同队列的兄弟消费者重启时抢走正在处理的消息
    await redis.rpush(processingQueue, '{"seq":3}');
    const movedAgain = await requeueStaleProcessing(
      redis,
      queueName,
      processingQueue,
      "测试",
    );
    assertEquals(movedAgain, 0, "每进程每队列只兜底一次");
    assertEquals(
      await redis.llen(processingQueue),
      1,
      "第二次调用不应搬走消息",
    );
  } finally {
    await redis.del(queueName, processingQueue).catch(() => {});
    await redis.quit().catch(() => {});
    _resetConsumerShutdownForTest();
  }
});

Deno.test("base-consumer: 关闭标记按实例隔离（停 A 不影响 B）", async () => {
  const redis = await connectRedisOrNull();
  if (!redis) {
    console.warn(
      "[warn] 未检测到可用 Redis，跳过关闭标记隔离测试（CI 与本地开发环境应提供 Redis）",
    );
    return;
  }
  await redis.quit().catch(() => {});

  _resetConsumerShutdownForTest();
  const queueA = `noj:test:shutdown:a:${RUN_ID}`;
  const queueB = `noj:test:shutdown:b:${RUN_ID}`;
  const handleMessage = () => Promise.resolve();
  const handleA = createConsumer({
    queueName: queueA,
    logLabel: "测试A",
    aliveRef: { value: false },
    handleMessage,
    blpopTimeout: 1,
  });
  const handleB = createConsumer({
    queueName: queueB,
    logLabel: "测试B",
    aliveRef: { value: false },
    handleMessage,
    blpopTimeout: 1,
  });

  // 只关停 A
  handleA.requestShutdown();
  await handleA(); // 应立即返回（不进入消费循环）

  let bSettled = false;
  const bLoop = handleB().then(() => {
    bSettled = true;
  });
  await new Promise((r) => setTimeout(r, 300));
  assertEquals(
    bSettled,
    false,
    "A 的关闭不应影响 B（此前共享单一模块级标记会连带停掉 B）",
  );

  // B 自行关闭后应退出
  handleB.requestShutdown();
  await Promise.race([
    bLoop,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("B 未在关闭请求后退出")), 5_000)
    ),
  ]);
  assertEquals(bSettled, true);
  _resetConsumerShutdownForTest();
});
