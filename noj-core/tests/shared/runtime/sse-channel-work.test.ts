/**
 * SSE 通道异步工作作用域测试（P2a，2026-10-20）。
 *
 * 使用 fake stream 与受控 Promise，不连接 Redis/DB，验证：
 * - onMessage 的权限/DB 异步与 writeSSE 整段在 run 内执行；
 * - run 拒绝或无 run 时 onMessage 拒绝都会关闭流，不产生未处理拒绝；
 * - 关闭后不再开始新的推送工作；
 * - 订阅退订函数被保留并可执行。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { _dispatchToLocalListenersForTest } from "../../../src/shared/sse/event-bus.ts";
import { subscribeToChannel } from "../../../src/shared/sse/server-helpers.ts";

function ticks(count = 5): Promise<void> {
  let promise = Promise.resolve();
  for (let i = 0; i < count; i++) {
    promise = promise.then(() => new Promise<void>((r) => setTimeout(r, 0)));
  }
  return promise;
}

function channel(name: string): string {
  return `noj:test:sse-work:${name}:${Math.random().toString(36).slice(2)}`;
}

Deno.test("sse-channel-work: onMessage 与 writeSSE 整段在 run 内执行", async () => {
  const ch = channel("in-run");
  const writes: string[] = [];
  const unsubscribers: Array<() => void> = [];
  let inRun = 0;
  let runCalls = 0;
  let violations = 0;

  subscribeToChannel(
    (fn) => unsubscribers.push(fn),
    ch,
    "test:event",
    {
      writeSSE: (payload: { data: string }) => {
        if (inRun !== 1) violations++;
        writes.push(payload.data);
        return Promise.resolve();
      },
    },
    () => false,
    () => {},
    async (message) => {
      if (inRun !== 1) violations++;
      await Promise.resolve();
      return `data:${message}`;
    },
    async (operation) => {
      runCalls++;
      inRun++;
      try {
        await operation();
      } finally {
        inRun--;
      }
    },
  );

  _dispatchToLocalListenersForTest(ch, "m1");
  await ticks();
  assertEquals(runCalls, 1);
  assertEquals(writes, ["data:m1"]);
  assertEquals(violations, 0, "onMessage 与 writeSSE 都必须在 run 内");
  assertEquals(unsubscribers.length, 1, "退订函数必须被保留");
  unsubscribers[0]!();
});

Deno.test("sse-channel-work: 无 run 时 onMessage 拒绝会关闭流且不泄漏", async () => {
  const ch = channel("reject-on-message");
  const unsubscribers: Array<() => void> = [];
  let closeCalls = 0;
  subscribeToChannel(
    (fn) => unsubscribers.push(fn),
    ch,
    "test:event",
    { writeSSE: () => Promise.resolve() },
    () => false,
    () => {
      closeCalls++;
    },
    () => Promise.reject(new Error("permission lookup failed")),
  );

  _dispatchToLocalListenersForTest(ch, "m1");
  await ticks();
  assertEquals(closeCalls, 1);
  unsubscribers[0]!();
});

Deno.test("sse-channel-work: run 自身拒绝时关闭流而不是 unhandled", async () => {
  const ch = channel("reject-run");
  const unsubscribers: Array<() => void> = [];
  let closeCalls = 0;
  subscribeToChannel(
    (fn) => unsubscribers.push(fn),
    ch,
    "test:event",
    { writeSSE: () => Promise.resolve() },
    () => false,
    () => {
      closeCalls++;
    },
    (message) => message,
    () => Promise.reject(new Error("run failed")),
  );

  _dispatchToLocalListenersForTest(ch, "m1");
  await ticks();
  assertEquals(closeCalls, 1);
  unsubscribers[0]!();
});

Deno.test("sse-channel-work: 关闭后不再开始新推送工作", async () => {
  const ch = channel("closed-gate");
  const unsubscribers: Array<() => void> = [];
  let closed = false;
  let runCalls = 0;
  subscribeToChannel(
    (fn) => unsubscribers.push(fn),
    ch,
    "test:event",
    { writeSSE: () => Promise.resolve() },
    () => closed,
    () => {},
    (message) => message,
    async (operation) => {
      runCalls++;
      await operation();
    },
  );

  closed = true;
  _dispatchToLocalListenersForTest(ch, "m1");
  await ticks();
  assertEquals(runCalls, 0);
  unsubscribers[0]!();
});

Deno.test("sse-channel-work: onMessage 返回 null 时不写入", async () => {
  const ch = channel("null-message");
  const unsubscribers: Array<() => void> = [];
  let writes = 0;
  let runCalls = 0;
  subscribeToChannel(
    (fn) => unsubscribers.push(fn),
    ch,
    "test:event",
    {
      writeSSE: () => {
        writes++;
        return Promise.resolve();
      },
    },
    () => false,
    () => {},
    () => null,
    async (operation) => {
      runCalls++;
      await operation();
    },
  );

  _dispatchToLocalListenersForTest(ch, "m1");
  await ticks();
  assertEquals(runCalls, 1);
  assertEquals(writes, 0);
  unsubscribers[0]!();
});
