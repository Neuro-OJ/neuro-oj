/**
 * waitUntil 行为测试（P1-A，零依赖）。
 *
 * 覆盖：首次立即读取、读取耗时计入预算、卡住请求可取消、确定性 HTTP 错误
 * 立即失败、短暂 5xx 后恢复、截止后无遗留请求、旧 attempt 完成而新 attempt
 * 未完成时不提前返回、超时诊断字段完整。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  WaitHttpError,
  WaitTimeoutError,
  waitUntil,
} from "../../fixtures/wait.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test("wait: 首次读取即完成时不创建等待计时器", async () => {
  let reads = 0;
  const started = performance.now();
  const value = await waitUntil(
    () => {
      reads++;
      return Promise.resolve("ready");
    },
    (result) => result === "ready",
    { timeoutMs: 5000, resourceId: "resource-1" },
  );
  assertEquals(value, "ready");
  assertEquals(reads, 1);
  assert(performance.now() - started < 100);
});

Deno.test("wait: 单次读取耗时计入总预算并在预算耗尽时超时", async () => {
  let reads = 0;
  const error = await assertRejects(
    () =>
      waitUntil(
        async (signal) => {
          reads++;
          // 模拟慢请求：可被单次请求预算取消。
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 500);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(signal.reason);
            }, { once: true });
          });
          return "late";
        },
        () => true,
        { timeoutMs: 40, resourceId: "slow-resource" },
      ),
    WaitTimeoutError,
  );
  assertEquals(reads, 1);
  assert(error.elapsedMs >= 30 && error.elapsedMs < 200);
  assert(error.message.includes("slow-resource"));
});

Deno.test("wait: 卡住的读取可被外部 signal 取消", async () => {
  const controller = new AbortController();
  let readSignal: AbortSignal | null = null;
  const reason = new Error("cancel-now");
  const pending = waitUntil(
    (signal) => {
      readSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    () => true,
    { timeoutMs: 5000, resourceId: "stuck", signal: controller.signal },
  );
  await delay(20);
  controller.abort(reason);
  const error = await assertRejects(() => pending, Error);
  assertEquals(error.message, "cancel-now");
  assertEquals(readSignal!.aborted, true);
});

Deno.test("wait: 404 立即失败且只读取一次", async () => {
  let reads = 0;
  const started = performance.now();
  const error = await assertRejects(
    () =>
      waitUntil(
        () => {
          reads++;
          return Promise.reject(new WaitHttpError(404, "not found"));
        },
        () => true,
        { timeoutMs: 5000, resourceId: "missing" },
      ),
    WaitHttpError,
  );
  assertEquals(error.status, 404);
  assertEquals(reads, 1);
  assert(performance.now() - started < 300);
});

Deno.test("wait: 短暂 503 后在预算内恢复", async () => {
  let reads = 0;
  const value = await waitUntil(
    () => {
      reads++;
      if (reads === 1) {
        return Promise.reject(new WaitHttpError(503, "temporarily down"));
      }
      return Promise.resolve("ok");
    },
    (result) => result === "ok",
    { timeoutMs: 1000, resourceId: "flaky", backoffMs: [10, 10] },
  );
  assertEquals(value, "ok");
  assertEquals(reads, 2);
});

Deno.test("wait: 超时错误保留最后 HTTP 状态、读取次数与最后错误", async () => {
  let reads = 0;
  const error = await assertRejects(
    () =>
      waitUntil(
        () => {
          reads++;
          return Promise.reject(new WaitHttpError(503, "upstream down"));
        },
        () => true,
        {
          timeoutMs: 80,
          resourceId: "submission-abc",
          backoffMs: [20, 20],
        },
      ),
    WaitTimeoutError,
  );
  assert(reads >= 2);
  assertEquals(error.resourceId, "submission-abc");
  assertEquals(error.lastHttpStatus, 503);
  assertEquals(error.reads, reads);
  assert(error.lastError instanceof WaitHttpError);
  assert(error.message.includes("upstream down"));
});

Deno.test("wait: 截止后不再发起读取", async () => {
  let reads = 0;
  const error = await assertRejects(
    () =>
      waitUntil(
        () => {
          reads++;
          return Promise.resolve("pending");
        },
        () => false,
        {
          timeoutMs: 120,
          resourceId: "no-leftover",
          backoffMs: [40, 40],
        },
      ),
    WaitTimeoutError,
  );
  const readsAtTimeout = reads;
  assert(readsAtTimeout >= 1);
  assertEquals(error.reads, readsAtTimeout);
  await delay(250);
  assertEquals(reads, readsAtTimeout);
});

Deno.test("wait: 旧 attempt 完成而新 attempt 未完成时不提前返回", async () => {
  const attempts = [
    { id: "old", state: "finished" },
    { id: "new", state: "queued" },
  ];
  let reads = 0;
  const result = await waitUntil(
    () => {
      reads++;
      // 第二次读取时新 attempt 才完成。
      if (reads === 2) attempts[1]!.state = "finished";
      return Promise.resolve(attempts.map((item) => ({ ...item })));
    },
    (items) => items.every((item) => item.state === "finished"),
    {
      timeoutMs: 1000,
      resourceId: "rejudge-submission",
      backoffMs: [10, 10, 10],
      describe: (items) =>
        items.map((item) => `${item.id}=${item.state}`).join(","),
    },
  );
  assertEquals(reads, 2);
  assertEquals(result.map((item) => item.state), ["finished", "finished"]);
});
