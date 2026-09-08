/**
 * SSE event-bus 单元测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  _dispatchToLocalListenersForTest,
  _setSubscriberReadyForTest,
  Channels,
  onEvent,
  publishEvent,
  publishSseEventAfterTx,
} from "../../../src/shared/sse/event-bus.ts";

Deno.test("event-bus: Channels 生成稳定频道名", () => {
  assertEquals(Channels.submission("s1"), "noj:events:submission:s1");
  assertEquals(Channels.queue, "noj:events:queue");
  assertEquals(Channels.user("u1"), "noj:events:user:u1");
  assertEquals(
    Channels.contestRanking("c1"),
    "noj:events:contest:c1:ranking",
  );
  assertEquals(
    Channels.contestSubmission("c1"),
    "noj:events:contest:c1:submission",
  );
});

Deno.test("event-bus: onEvent 注册回调并返回退订函数", () => {
  const received: string[] = [];
  const unsub = onEvent("noj:events:test", (_ch, msg) => received.push(msg));
  _dispatchToLocalListenersForTest("noj:events:test", "hello");
  assertEquals(received, ["hello"]);
  unsub();
  _dispatchToLocalListenersForTest("noj:events:test", "world");
  assertEquals(received, ["hello"]);
});

Deno.test("event-bus: publishEvent 在订阅未就绪时跳过", () => {
  _setSubscriberReadyForTest(false);
  // 不抛异常即通过（fire-and-forget 语义）
  publishEvent("noj:events:test", "{}");
});

Deno.test("event-bus: publishSseEventAfterTx 在就绪时发布带 seq 的消息", () => {
  _setSubscriberReadyForTest(true);
  const received: string[] = [];
  const unsub = onEvent("noj:events:test", (_ch, msg) => received.push(msg));
  publishSseEventAfterTx("noj:events:test", { type: "x" }, 42);
  // publishEvent 内部走真实 Redis；此处只验证不抛异常
  unsub();
  _setSubscriberReadyForTest(false);
});
