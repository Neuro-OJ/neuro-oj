/**
 * SSE 事件订阅者生命周期测试（P2a，2026-10-20）。
 *
 * 使用 fake Pub/Sub Redis 与受控 Promise，不连接真实 Redis：
 * - 首次 connect 与 ready 事件只 PSUBSCRIBE 一次；
 * - 重连后恰好重新订阅一次；
 * - stop 停止分发/再订阅，done 等连接关闭后才 resolve；
 * - quit 处于 connecting 失败时用 disconnect 兜底，done 不悬挂；
 * - 重复 stop 幂等。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  _setSubscriberReadyForTest,
  initEventSubscriber,
  onEvent,
} from "../../../src/shared/sse/event-bus.ts";
import type { RedisClient } from "../../../src/shared/mq/connection.ts";

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

interface FakePubSubOptions {
  connect?: () => Promise<void>;
  psubscribe?: () => Promise<unknown>;
  quit?: () => Promise<string>;
  disconnect?: () => void | Promise<void>;
}

class FakePubSubRedis {
  status = "waiting";
  connectCalls = 0;
  psubscribeCalls = 0;
  quitCalls = 0;
  disconnectCalls = 0;
  private readonly handlers = new Map<string, Set<Handler>>();

  constructor(private readonly options: FakePubSubOptions = {}) {}

  connect(): Promise<void> {
    this.connectCalls++;
    this.status = "connecting";
    return this.options.connect ? this.options.connect() : Promise.resolve();
  }

  psubscribe(): Promise<unknown> {
    this.psubscribeCalls++;
    return this.options.psubscribe
      ? this.options.psubscribe()
      : Promise.resolve(1);
  }

  quit(): Promise<string> {
    this.quitCalls++;
    this.status = "end";
    return this.options.quit ? this.options.quit() : Promise.resolve("OK");
  }

  disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.status = "end";
    return Promise.resolve(this.options.disconnect?.());
  }

  on(event: string, handler: Handler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      handler(...args);
    }
  }
}

function asRedis(fake: FakePubSubRedis): RedisClient {
  return fake as unknown as RedisClient;
}

Deno.test("event-subscriber: 首次连接与 ready 只订阅一次，重连后恰好多订阅一次", async () => {
  _setSubscriberReadyForTest(false);
  const fake = new FakePubSubRedis();
  const task = initEventSubscriber({ createRedis: () => asRedis(fake) });

  await waitFor(() => fake.psubscribeCalls === 1);
  fake.emit("ready");
  await delay(20);
  assertEquals(
    fake.psubscribeCalls,
    1,
    "首次 connect 与 ready 不得重复 PSUBSCRIBE",
  );

  fake.emit("reconnecting");
  fake.emit("ready");
  await waitFor(() => fake.psubscribeCalls === 2);
  fake.emit("ready");
  await delay(20);
  assertEquals(fake.psubscribeCalls, 2, "重复 ready 事件不得再次订阅");

  task.stop();
  await withTimeout(task.done, 1_000, "正常关闭");
  assertEquals(fake.quitCalls, 1);
  _setSubscriberReadyForTest(false);
});

Deno.test("event-subscriber: stop 停止分发并等待 quit 完成后 done 才 resolve，且重复 stop 幂等", async () => {
  _setSubscriberReadyForTest(false);
  let resolveQuit: (value: string) => void = () => {};
  let quitGate: Promise<string> = Promise.resolve("OK");
  const fake = new FakePubSubRedis({
    quit: () => {
      quitGate = new Promise<string>((resolve) => {
        resolveQuit = resolve;
      });
      return quitGate;
    },
  });
  const task = initEventSubscriber({ createRedis: () => asRedis(fake) });
  await waitFor(() => fake.psubscribeCalls === 1);

  const received: string[] = [];
  const unsubscribe = onEvent("noj:events:test", (_channel, message) => {
    received.push(message);
  });
  fake.emit("pmessage", "noj:events:*", "noj:events:test", "m1");
  assertEquals(received, ["m1"]);

  let doneSettled = false;
  task.done.then(() => {
    doneSettled = true;
  });
  task.stop();
  await delay(20);
  assertEquals(doneSettled, false, "quit 未完成前 done 不得 resolve");

  // stop 后不得再分发，也不得因 ready 事件重新订阅。
  fake.emit("pmessage", "noj:events:*", "noj:events:test", "m2");
  fake.emit("ready");
  await delay(20);
  assertEquals(received, ["m1"], "stop 后 pmessage 必须被门控");
  assertEquals(fake.psubscribeCalls, 1, "stop 后 ready 不得再订阅");

  resolveQuit("OK");
  await withTimeout(task.done, 1_000, "关闭完成");
  assertEquals(doneSettled, true);
  assertEquals(fake.quitCalls, 1);

  task.stop();
  await delay(10);
  assertEquals(fake.quitCalls, 1, "重复 stop 不得重复 quit");
  unsubscribe();
  _setSubscriberReadyForTest(false);
});

Deno.test("event-subscriber: connect 挂起时 stop 用 disconnect 兜底并结束 done", async () => {
  _setSubscriberReadyForTest(false);
  let rejectConnect: (error: Error) => void = () => {};
  const fake = new FakePubSubRedis({
    // 模拟 connect 长期挂起；disconnect 使其真正收尾（done 必须观察到）。
    connect: () =>
      new Promise<void>((_, reject) => {
        rejectConnect = reject;
      }),
    quit: () => Promise.reject(new Error("quit while connecting")),
    disconnect: () => {
      rejectConnect(new Error("connect aborted by disconnect"));
    },
  });
  const task = initEventSubscriber({ createRedis: () => asRedis(fake) });
  await waitFor(() => fake.connectCalls === 1);

  task.stop();
  await withTimeout(task.done, 1_000, "connect 挂起时关闭");
  assertEquals(fake.quitCalls, 1);
  assertEquals(
    fake.disconnectCalls,
    1,
    "quit 失败必须用 disconnect 明确兜底",
  );
  _setSubscriberReadyForTest(false);
});

Deno.test("event-subscriber: stop 时挂起的 psubscribe 真正结束后 done 才 resolve", async () => {
  _setSubscriberReadyForTest(false);
  let resolveSubscribe: (value: unknown) => void = () => {};
  const pendingSubscribe = new Promise<unknown>((resolve) => {
    resolveSubscribe = resolve;
  });
  const fake = new FakePubSubRedis({
    psubscribe: () => pendingSubscribe,
  });
  const task = initEventSubscriber({ createRedis: () => asRedis(fake) });
  await waitFor(() => fake.psubscribeCalls === 1);

  let doneSettled = false;
  task.done.then(() => {
    doneSettled = true;
  });
  task.stop();
  await delay(30);
  assertEquals(
    doneSettled,
    false,
    "psubscribe 未真正结束前 done 不得 resolve",
  );

  resolveSubscribe(1);
  await withTimeout(task.done, 1_000, "等待挂起订阅收尾");
  assertEquals(doneSettled, true);
  _setSubscriberReadyForTest(false);
});

Deno.test("event-subscriber: disconnect 同步返回 void 时不抛 TypeError", async () => {
  _setSubscriberReadyForTest(false);
  const fake = new FakePubSubRedis({
    quit: () => Promise.reject(new Error("quit failed")),
    // 同步 void：旧写法的 redis.disconnect().catch(...) 会在此抛 TypeError。
    disconnect: () => undefined,
  });
  const task = initEventSubscriber({ createRedis: () => asRedis(fake) });
  await waitFor(() => fake.psubscribeCalls === 1);
  task.stop();
  await withTimeout(task.done, 1_000, "同步 void disconnect 兜底");
  assertEquals(fake.disconnectCalls, 1);
  _setSubscriberReadyForTest(false);
});

Deno.test("event-subscriber: 首次连接失败不产生未处理拒绝且可正常停止", async () => {
  _setSubscriberReadyForTest(false);
  const fake = new FakePubSubRedis({
    connect: () => Promise.reject(new Error("initial connect failed")),
  });
  const task = initEventSubscriber({ createRedis: () => asRedis(fake) });
  await delay(30);
  assertEquals(fake.psubscribeCalls, 0);

  task.stop();
  await withTimeout(task.done, 1_000, "失败后关闭");
  assertEquals(fake.quitCalls, 1);
  _setSubscriberReadyForTest(false);
});

Deno.test("event-subscriber: 旧代次晚到完成不得阻止新代次订阅", async () => {
  _setSubscriberReadyForTest(false);
  const resolvers: Array<(value: unknown) => void> = [];
  const fake = new FakePubSubRedis({
    psubscribe: () =>
      new Promise<unknown>((resolve) => {
        resolvers.push(resolve);
      }),
  });
  const task = initEventSubscriber({ createRedis: () => asRedis(fake) });
  await waitFor(() => fake.psubscribeCalls === 1);

  // 旧连接进入重连代次后，其 psubscribe 才晚到完成。
  fake.emit("reconnecting");
  resolvers[0]!(1);
  await delay(10);
  // 新代次 ready 必须仍能发起订阅，不能被旧代次 subscribed 状态挡住。
  fake.emit("ready");
  await waitFor(() => fake.psubscribeCalls === 2);
  resolvers[1]!(1);
  await delay(10);
  // 当前代次已订阅：重复 ready 不再订阅。
  fake.emit("ready");
  await delay(20);
  assertEquals(fake.psubscribeCalls, 2);

  task.stop();
  await withTimeout(task.done, 1_000, "代次竞态关闭");
  _setSubscriberReadyForTest(false);
});

Deno.test("event-subscriber: quit 与 disconnect 都失败时 done 拒绝", async () => {
  _setSubscriberReadyForTest(false);
  const fake = new FakePubSubRedis({
    quit: () => Promise.reject(new Error("quit failed")),
    disconnect: () => Promise.reject(new Error("disconnect failed")),
  });
  const task = initEventSubscriber({ createRedis: () => asRedis(fake) });
  await waitFor(() => fake.psubscribeCalls === 1);
  task.stop();
  await assertRejects(() => task.done, AggregateError);
  _setSubscriberReadyForTest(false);
});
