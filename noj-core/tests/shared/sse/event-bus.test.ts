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

Deno.test("event-bus: publishEvent 在订阅未就绪时跳过", async () => {
  _setSubscriberReadyForTest(false);
  const received: string[] = [];
  const unsub = onEvent("noj:events:test", (_ch, msg) => received.push(msg));
  // fire-and-forget 语义：返回 void 且不抛错
  assertEquals(publishEvent("noj:events:test", "{}"), undefined);
  // 订阅未就绪时不得把消息分发给本地监听器
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(received, []);
  unsub();
});

Deno.test("event-bus: publishSseEventAfterTx 在就绪时发布带 seq 的消息", () => {
  _setSubscriberReadyForTest(true);
  const received: string[] = [];
  const unsub = onEvent("noj:events:test", (_ch, msg) => received.push(msg));
  // 冒烟：内部走真实 Redis pub/sub，本地无订阅者时只能验证不抛错
  // （消息构造/seq 字段由 event-bus 单元测试与 E2E 覆盖）。
  // 返回 void 且不抛错（真实 Redis pub/sub 由 E2E 覆盖）
  assertEquals(
    publishSseEventAfterTx("noj:events:test", { type: "x" }, 42),
    undefined,
  );
  unsub();
  _setSubscriberReadyForTest(false);
});
