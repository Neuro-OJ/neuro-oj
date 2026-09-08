/**
 * SSE server-helpers 单元测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  lastEventId,
  subscribeToChannel,
} from "../../../src/shared/sse/server-helpers.ts";

function fakeCtx(header?: string, query?: string) {
  return {
    req: {
      header: (key: string) => (key === "last-event-id" ? header : undefined),
      query: (key: string) => (key === "afterSeq" ? query : undefined),
    },
  };
}

Deno.test("server-helpers: lastEventId 解析 Last-Event-ID 头", () => {
  assertEquals(lastEventId(fakeCtx("42")), 42);
  assertEquals(lastEventId(fakeCtx("0")), 0);
  assertEquals(lastEventId(fakeCtx("-1")), 0);
  assertEquals(lastEventId(fakeCtx("abc")), 0);
});

Deno.test("server-helpers: lastEventId 回退 afterSeq 查询参数", () => {
  assertEquals(lastEventId(fakeCtx(undefined, "7")), 7);
  assertEquals(lastEventId(fakeCtx(undefined, "3.9")), 3);
  assertEquals(lastEventId(fakeCtx(undefined, "bad")), 0);
});

Deno.test("server-helpers: lastEventId 缺省为 0", () => {
  assertEquals(lastEventId(fakeCtx()), 0);
});

Deno.test("server-helpers: subscribeToChannel 转发消息并支持转换", async () => {
  const writes: Array<{ event: string; data: string }> = [];
  const unsubs: Array<() => void> = [];
  const stream = {
    writeSSE: (frame: { event: string; data: string }) => {
      writes.push(frame);
      return Promise.resolve();
    },
  };
  const closed = () => false;
  const close = () => {};

  subscribeToChannel(
    (fn) => unsubs.push(fn),
    "noj:events:test",
    "test:event",
    stream,
    closed,
    close,
    (message) => (message === "drop" ? null : `transformed:${message}`),
  );

  // 通过 event-bus 测试钩子触发本地监听器
  const { _dispatchToLocalListenersForTest } = await import(
    "../../../src/shared/sse/event-bus.ts"
  );
  _dispatchToLocalListenersForTest("noj:events:test", "hello");
  _dispatchToLocalListenersForTest("noj:events:test", "drop");

  // subscribeToChannel 内部通过 Promise.resolve().then 异步写流，等待微任务完成
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEquals(writes.length, 1);
  assertEquals(writes[0].event, "test:event");
  assertEquals(writes[0].data, "transformed:hello");
  assertEquals(unsubs.length, 1);
});
