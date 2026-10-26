/**
 * 消费者生命周期测试（P2a，2026-10-20）。
 *
 * 全部使用 fake Redis 与受控 Promise，不连接真实 PostgreSQL/Redis：
 * 1. stop 发生在 connect 挂起窗口；
 * 2. stop 发生在 BRPOPLPUSH 已发出但未返回窗口（不得误确认/丢消息）；
 * 3. stop 发生在 handler 执行中（必须等在途写库完成）；
 * 4. stop 发生在可中断重连退避中；
 * 5. 结果消费者池部分失败仍等待全部实例退出。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  _getConsumerShutdownWaiterCountForTest,
  _resetConsumerShutdownForTest,
  type ConsumerHandle,
  createConsumer,
} from "../../../src/shared/mq/base-consumer.ts";
import type { RedisClient } from "../../../src/shared/mq/connection.ts";
import { startResultConsumerPool } from "../../../src/modules/evaluations/mq/consumer.ts";

type Handler = (...args: unknown[]) => void;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("等待条件超时");
    await delay(5);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} 超时`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface FakeConsumerRedisOptions {
  connect?: () => Promise<void>;
  /** 模拟 ioredis 在部分场景下 disconnect() 同步返回 void。 */
  disconnectVoid?: boolean;
  /** 模拟 disconnect 失败（连接仍可能存活）。 */
  disconnectError?: Error;
  brpoplpush?: (
    source: string,
    destination: string,
    timeout: number,
  ) => Promise<string | null>;
}

/** 仅实现 base-consumer 实际调用的方法，未用方法由 as unknown 转换兜底。 */
class FakeConsumerRedis {
  status = "waiting";
  connectCalls = 0;
  disconnectCalls = 0;
  brpopCalls = 0;
  readonly lremCalls: Array<{ key: string; value: string }> = [];
  readonly rpushCalls: Array<{ key: string; value: string }> = [];
  private readonly handlers = new Map<string, Set<Handler>>();

  constructor(private readonly options: FakeConsumerRedisOptions = {}) {}

  connect(): Promise<void> {
    this.connectCalls++;
    this.status = "connecting";
    return this.options.connect ? this.options.connect() : Promise.resolve();
  }

  disconnect(): Promise<void> | void {
    this.disconnectCalls++;
    this.status = "end";
    if (this.options.disconnectError) {
      return Promise.reject(this.options.disconnectError);
    }
    if (this.options.disconnectVoid) return;
    return Promise.resolve();
  }

  brpoplpush(
    source: string,
    destination: string,
    timeout: number,
  ): Promise<string | null> {
    this.brpopCalls++;
    return this.options.brpoplpush
      ? this.options.brpoplpush(source, destination, timeout)
      : Promise.resolve(null);
  }

  /** 启动期残留重投：本测试默认没有残留。 */
  rpoplpush(): Promise<string | null> {
    return Promise.resolve(null);
  }

  lrem(key: string, _count: number, value: string): Promise<number> {
    this.lremCalls.push({ key, value });
    return Promise.resolve(1);
  }

  rpush(key: string, value: string): Promise<number> {
    this.rpushCalls.push({ key, value });
    return Promise.resolve(1);
  }

  on(event: string, handler: Handler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler);
  }
}

function asRedis(fake: FakeConsumerRedis): RedisClient {
  return fake as unknown as RedisClient;
}

Deno.test("consumer-lifecycle: stop 在 connect 挂起窗口立即结束并断开连接", async () => {
  _resetConsumerShutdownForTest();
  const fake = new FakeConsumerRedis({
    // 永不 settle：模拟网络不可达时 connect 长时间挂起。
    connect: () => new Promise<void>(() => {}),
  });
  const aliveRef = { value: false };
  const handle = createConsumer({
    queueName: `noj:test:lifecycle:connect:${Date.now()}`,
    logLabel: "测试连接挂起",
    aliveRef,
    handleMessage: () => Promise.resolve(),
    createRedis: () => asRedis(fake),
    blpopTimeout: 1,
  });

  const running = handle();
  await waitFor(() => fake.connectCalls === 1);
  const startedAt = Date.now();
  handle.requestShutdown();
  await withTimeout(running, 500, "connect 挂起时 stop");
  assertEquals(
    Date.now() - startedAt < 400,
    true,
    "stop 必须打断挂起的 connect",
  );
  assertEquals(fake.disconnectCalls >= 1, true, "挂起连接必须被断开");
  assertEquals(aliveRef.value, false);
  _resetConsumerShutdownForTest();
});

Deno.test("consumer-lifecycle: stop 在 BRPOPLPUSH 未返回窗口结束且不误确认消息", async () => {
  _resetConsumerShutdownForTest();
  let resolvePop: (value: string | null) => void = () => {};
  const pendingPop = new Promise<string | null>((resolve) => {
    resolvePop = resolve;
  });
  const fake = new FakeConsumerRedis({
    brpoplpush: () => pendingPop,
  });
  const handle = createConsumer({
    queueName: `noj:test:lifecycle:pop:${Date.now()}`,
    logLabel: "测试领取挂起",
    aliveRef: { value: false },
    handleMessage: () => Promise.resolve(),
    createRedis: () => asRedis(fake),
    blpopTimeout: 1,
  });

  const running = handle();
  await waitFor(() => fake.brpopCalls === 1);
  handle.requestShutdown();
  await withTimeout(running, 500, "BRPOPLPUSH 挂起时 stop");
  assertEquals(fake.brpopCalls, 1, "stop 后不得再发起新的领取");
  assertEquals(fake.lremCalls.length, 0, "未返回的消息绝不能被确认");

  // 模拟消息在 stop 之后才进入 processing：必须被忽略并留给 sweeper 恢复。
  resolvePop(JSON.stringify({ late: true }));
  await delay(10);
  assertEquals(fake.lremCalls.length, 0, "迟到的消息仍不得确认");
  _resetConsumerShutdownForTest();
});

Deno.test("consumer-lifecycle: stop 在 handler 执行中时 done 等待在途写库完成", async () => {
  _resetConsumerShutdownForTest();
  let markStarted: () => void = () => {};
  const handlerStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let releaseHandler: () => void = () => {};
  const handlerGate = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  let brpopCalls = 0;
  const fake = new FakeConsumerRedis({
    brpoplpush: () => {
      brpopCalls++;
      return Promise.resolve(JSON.stringify({ seq: brpopCalls }));
    },
  });
  const aliveRef = { value: false };
  const handle = createConsumer({
    queueName: `noj:test:lifecycle:handler:${Date.now()}`,
    logLabel: "测试在途处理",
    aliveRef,
    handleMessage: async () => {
      markStarted();
      await handlerGate;
    },
    createRedis: () => asRedis(fake),
    blpopTimeout: 1,
  });

  let settled = false;
  const running = handle().finally(() => {
    settled = true;
  });
  await handlerStarted;
  handle.requestShutdown();
  await delay(30);
  assertEquals(settled, false, "handler 未完成前 done 不得 resolve");
  assertEquals(fake.lremCalls.length, 0, "handler 完成前不得确认");

  releaseHandler();
  await withTimeout(running, 500, "handler 完成后关闭");
  assertEquals(settled, true);
  assertEquals(brpopCalls, 1, "stop 后不得领取下一条");
  assertEquals(fake.lremCalls.length, 1, "已领取消息必须在处理完成后确认");
  assertEquals(aliveRef.value, false);
  _resetConsumerShutdownForTest();
});

Deno.test("consumer-lifecycle: stop 打断重连退避等待", async () => {
  _resetConsumerShutdownForTest();
  const fake = new FakeConsumerRedis({
    connect: () => Promise.reject(new Error("connect refused")),
  });
  const handle = createConsumer({
    queueName: `noj:test:lifecycle:backoff:${Date.now()}`,
    logLabel: "测试退避",
    aliveRef: { value: false },
    handleMessage: () => Promise.resolve(),
    createRedis: () => asRedis(fake),
    blpopTimeout: 1,
  });

  const running = handle();
  await waitFor(() => fake.connectCalls === 1);
  // 等第一次失败处理完、进入 1s 退避。
  await delay(60);
  const startedAt = Date.now();
  handle.requestShutdown();
  await withTimeout(running, 400, "退避窗口 stop");
  assertEquals(
    Date.now() - startedAt < 300,
    true,
    "stop 必须立即打断退避而不是等满 1s",
  );
  assertEquals(fake.disconnectCalls >= 1, true);
  _resetConsumerShutdownForTest();
});

Deno.test("consumer-lifecycle: disconnect 同步返回 void 不触发 TypeError", async () => {
  _resetConsumerShutdownForTest();
  const fake = new FakeConsumerRedis({
    disconnectVoid: true,
    // 领取挂起，保证 stop 时走 finally 的 disconnect 路径。
    brpoplpush: () => new Promise<string | null>(() => {}),
  });
  const handle = createConsumer({
    queueName: `noj:test:lifecycle:void-disconnect:${Date.now()}`,
    logLabel: "测试同步 void 断开",
    aliveRef: { value: false },
    handleMessage: () => Promise.resolve(),
    createRedis: () => asRedis(fake),
    blpopTimeout: 1,
  });

  const running = handle();
  await waitFor(() => fake.brpopCalls === 1);
  handle.requestShutdown();
  await withTimeout(running, 500, "同步 void disconnect");
  assertEquals(fake.disconnectCalls >= 1, true);
  _resetConsumerShutdownForTest();
});

Deno.test("consumer-lifecycle: 消息先返回但 stop 已置位时不再启动 handler", async () => {
  _resetConsumerShutdownForTest();
  let resolvePop: (value: string | null) => void = () => {};
  const pendingPop = new Promise<string | null>((resolve) => {
    resolvePop = resolve;
  });
  const fake = new FakeConsumerRedis({ brpoplpush: () => pendingPop });
  let handlerCalls = 0;
  const handle = createConsumer({
    queueName: `noj:test:lifecycle:message-after-stop:${Date.now()}`,
    logLabel: "测试消息后停止",
    aliveRef: { value: false },
    handleMessage: () => {
      handlerCalls++;
      return Promise.resolve();
    },
    createRedis: () => asRedis(fake),
    blpopTimeout: 1,
  });

  const running = handle();
  await waitFor(() => fake.brpopCalls === 1);
  // 先让 pop 返回（其 microtask 先入队），再置 stop：race 会拿到消息，
  // 但 state.requested 已 true，必须保留在 processing 且不调用 handler。
  resolvePop(JSON.stringify({ late: true }));
  handle.requestShutdown();
  await withTimeout(running, 500, "消息后停止");
  assertEquals(handlerCalls, 0, "stop 后不得为新消息开启 handler");
  assertEquals(fake.lremCalls.length, 0, "不得确认该消息");
  _resetConsumerShutdownForTest();
});

Deno.test("consumer-lifecycle: 连接断开失败时 done 必须拒绝而不是假装成功", async () => {
  _resetConsumerShutdownForTest();
  const fake = new FakeConsumerRedis({
    brpoplpush: () => new Promise<string | null>(() => {}),
    disconnectError: new Error("disconnect boom"),
  });
  const handle = createConsumer({
    queueName: `noj:test:lifecycle:disconnect-fail:${Date.now()}`,
    logLabel: "测试断开失败",
    aliveRef: { value: false },
    handleMessage: () => Promise.resolve(),
    createRedis: () => asRedis(fake),
    blpopTimeout: 1,
  });

  const running = handle();
  await waitFor(() => fake.brpopCalls === 1);
  handle.requestShutdown();
  await assertRejects(
    () => running,
    Error,
    "断开失败",
  );
  _resetConsumerShutdownForTest();
});

Deno.test("consumer-lifecycle: 大量消息不会累积 shutdown 等待者", async () => {
  _resetConsumerShutdownForTest();
  let processed = 0;
  let maxWaiters = 0;
  let stopNow: () => void = () => {};
  const fake = new FakeConsumerRedis({
    brpoplpush: () => {
      maxWaiters = Math.max(
        maxWaiters,
        _getConsumerShutdownWaiterCountForTest().shutdownWaiters,
      );
      return Promise.resolve(JSON.stringify({ seq: processed + 1 }));
    },
  });
  const handle = createConsumer({
    queueName: `noj:test:lifecycle:waiter-growth:${Date.now()}`,
    logLabel: "测试等待者增长",
    aliveRef: { value: false },
    handleMessage: () => {
      maxWaiters = Math.max(
        maxWaiters,
        _getConsumerShutdownWaiterCountForTest().shutdownWaiters,
      );
      processed++;
      if (processed >= 200) stopNow();
      return Promise.resolve();
    },
    createRedis: () => asRedis(fake),
    blpopTimeout: 1,
  });
  stopNow = () => handle.requestShutdown();

  await withTimeout(handle(), 5_000, "处理大量消息");
  assertEquals(processed, 200);
  assertEquals(
    maxWaiters <= 1,
    true,
    `每轮最多一个 shutdown waiter，实际 ${maxWaiters}`,
  );
  assertEquals(
    _getConsumerShutdownWaiterCountForTest().states,
    0,
    "消费者退出后必须从注册表移除",
  );
  _resetConsumerShutdownForTest();
});

Deno.test("consumer-lifecycle: _reset 会停止并清理注册状态而不是复活", async () => {
  _resetConsumerShutdownForTest();
  const fake = new FakeConsumerRedis({
    connect: () => new Promise<void>(() => {}),
  });
  const handle = createConsumer({
    queueName: `noj:test:lifecycle:reset:${Date.now()}`,
    logLabel: "测试复位",
    aliveRef: { value: false },
    handleMessage: () => Promise.resolve(),
    createRedis: () => asRedis(fake),
    blpopTimeout: 1,
  });

  const running = handle();
  await waitFor(() => fake.connectCalls === 1);
  _resetConsumerShutdownForTest();
  await withTimeout(running, 500, "复位后退出");
  assertEquals(_getConsumerShutdownWaiterCountForTest().states, 0);
  _resetConsumerShutdownForTest();
});

Deno.test("consumer-lifecycle: 结果池部分失败仍等待全部消费者退出并保留错误", async () => {
  let factoryCalls = 0;
  const shutdownCalls: number[] = [];
  let releasePending: () => void = () => {};
  const pendingGate = new Promise<void>((resolve) => {
    releasePending = resolve;
  });

  const consumerFactory = (): ConsumerHandle => {
    const index = factoryCalls++;
    if (index === 0) {
      const start = (() =>
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("consumer-0 crashed")), 10);
        })) as ConsumerHandle;
      start.requestShutdown = () => {
        shutdownCalls.push(index);
      };
      return start;
    }
    const start = (() => pendingGate) as ConsumerHandle;
    start.requestShutdown = () => {
      shutdownCalls.push(index);
      releasePending();
    };
    return start;
  };

  const task = startResultConsumerPool({
    concurrency: 3,
    consumerFactory,
  });
  let rejection: unknown = null;
  task.done.catch((error) => {
    rejection = error;
  });

  await delay(60);
  assertEquals(
    rejection,
    null,
    "部分消费者失败后 done 不得提前 reject（其它消费者仍在运行）",
  );

  task.stop();
  await waitFor(() => rejection !== null, 1_000);
  assertEquals(shutdownCalls.length, 3, "stop 必须逐个 requestShutdown");
  assertEquals(rejection instanceof AggregateError, true);
  const aggregate = rejection as AggregateError;
  assertEquals(aggregate.errors.length, 1);
  assertEquals(
    aggregate.errors[0] instanceof Error &&
      (aggregate.errors[0] as Error).message === "consumer-0 crashed",
    true,
    "真实错误必须保留",
  );
  await assertRejects(() => task.done, AggregateError);
});
