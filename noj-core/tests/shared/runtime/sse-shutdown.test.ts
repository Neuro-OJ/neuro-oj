/**
 * SSE 长连接关闭行为测试。
 *
 * 使用真实 127.0.0.1:0 Deno.serve + Hono SSE 端点 + fetch reader，
 * 不连数据库/Redis，验证：
 * - 有活跃 SSE 时 shutdown 能完成排空并关闭依赖；
 * - setup 仍在异步读写时，依赖关闭要等 setup 结束；
 * - 已接收的异步事件回调（ctx.run）在途时，依赖关闭也要等它结束；
 * - close 后注册退订立即清理；关闭后新连接不能重新打开泄漏。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import {
  createSseStream,
  createSseStreamScope,
  type SseStreamContext,
} from "../../../src/shared/sse/sse-stream.ts";
import { createManagedTaskGroup } from "../../../src/shared/runtime/managed-task.ts";
import { performShutdown } from "../../../src/shared/runtime/shutdown.ts";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function serve(app: Hono) {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0 },
    app.fetch,
  );
  const address = server.addr as Deno.NetAddr;
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function readAll(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    if (value) text += decoder.decode(value, { stream: true });
  }
}

/**
 * 纯 test:runtime 无预加载事务，开启严格 sanitizer；
 * test-shared 的 tests/preload.ts 会启动数据库事务，其 rollback 计时器不属于
 * 本测试但会被 Deno sanitizer 归因到当前用例，因此仅在无 DATABASE_URL 时启用。
 * 所有行为断言始终保留。
 */
const STRICT_RESOURCE_SANITIZER = !Deno.env.get("DATABASE_URL");

Deno.test({
  name: "sse-shutdown: 有活跃 SSE 时关闭长连接即可完成 HTTP 排空并关闭依赖",
  sanitizeOps: STRICT_RESOURCE_SANITIZER,
  sanitizeResources: STRICT_RESOURCE_SANITIZER,
  async fn() {
    const scope = createSseStreamScope();
    const events: string[] = [];
    const app = new Hono();
    app.get(
      "/events",
      (c) =>
        createSseStream(
          c,
          async (ctx) => {
            events.push("setup:start");
            ctx.onUnsubscribe(() => events.push("unsub:1"));
            ctx.onUnsubscribe(() => events.push("unsub:2"));
            await ctx.stream.writeSSE({ event: "ready", data: "1" });
            events.push("setup:end");
          },
          { scope, safetyTimeoutMs: 0 },
        ),
    );

    const { server, base } = serve(app);
    const response = await fetch(`${base}/events`);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assertEquals(first.done, false);
    assertEquals(
      new TextDecoder().decode(first.value).includes("event: ready"),
      true,
    );
    assertEquals(scope.activeCount(), 1);

    const report = await performShutdown({
      http: { name: "http", shutdown: () => server.shutdown() },
      tasks: createManagedTaskGroup(),
      connections: {
        name: "sse-streams",
        closeAll: () => scope.closeAll(),
        doneAll: () => scope.doneAll(),
      },
      resources: [{
        name: "db",
        close: () => {
          events.push("close:db");
        },
      }],
      httpTimeoutMs: 2_000,
      tasksTimeoutMs: 1_000,
      connectionsTimeoutMs: 2_000,
    });

    await readAll(reader);
    assertEquals(report.clean, true);
    assertEquals(report.httpDrained, true);
    assertEquals(report.connectionsSettled, true);
    assertEquals(report.connectionsClosed, 1);
    assertEquals(report.resourcesClosed, true);
    assertEquals(scope.activeCount(), 0);
    assertEquals(events.includes("close:db"), true);
    assertEquals(events.includes("unsub:1"), true);
    assertEquals(events.includes("unsub:2"), true);
  },
});

Deno.test({
  name: "sse-shutdown: setup 异步在途时 close 后仍等待 setup 结束才关闭依赖",
  sanitizeOps: STRICT_RESOURCE_SANITIZER,
  sanitizeResources: STRICT_RESOURCE_SANITIZER,
  async fn() {
    const scope = createSseStreamScope();
    const events: string[] = [];
    const setupStarted = deferred();
    const releaseSetup = deferred();
    let setupFinished = false;

    const app = new Hono();
    app.get(
      "/slow",
      (c) =>
        createSseStream(
          c,
          async (ctx) => {
            setupStarted.resolve();
            await releaseSetup.promise;
            setupFinished = true;
            events.push("setup:end");
            await ctx.stream.writeSSE({ event: "ready", data: "1" });
          },
          { scope, safetyTimeoutMs: 0 },
        ),
    );

    const { server, base } = serve(app);
    const response = await fetch(`${base}/slow`);
    const reader = response.body!.getReader();
    await setupStarted.promise;

    const reportPromise = performShutdown({
      http: { name: "http", shutdown: () => server.shutdown() },
      tasks: createManagedTaskGroup(),
      connections: {
        name: "sse-streams",
        closeAll: () => scope.closeAll(),
        doneAll: () => scope.doneAll(),
      },
      resources: [{
        name: "db",
        close: () => {
          events.push("close:db");
        },
      }],
      httpTimeoutMs: 5_000,
      tasksTimeoutMs: 1_000,
      connectionsTimeoutMs: 5_000,
    });

    // shutdown 已经开始；setup 未结束时 DB 不得关闭。
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assertEquals(setupFinished, false);
    assertEquals(events.includes("close:db"), false);

    releaseSetup.resolve();
    const report = await reportPromise;
    await readAll(reader);
    assertEquals(setupFinished, true);
    assertEquals(
      events.indexOf("setup:end") < events.indexOf("close:db"),
      true,
      "依赖关闭必须发生在 setup 结束之后",
    );
    assertEquals(report.clean, true);
    assertEquals(report.connectionsSettled, true);
    assertEquals(scope.activeCount(), 0);
  },
});

Deno.test({
  name: "sse-shutdown: 在途事件回调结束前不关闭依赖",
  sanitizeOps: STRICT_RESOURCE_SANITIZER,
  sanitizeResources: STRICT_RESOURCE_SANITIZER,
  async fn() {
    const scope = createSseStreamScope();
    const events: string[] = [];
    let streamCtx: SseStreamContext | undefined;
    const opStarted = deferred();
    const releaseOp = deferred();

    const app = new Hono();
    app.get(
      "/events",
      (c) =>
        createSseStream(
          c,
          async (ctx) => {
            streamCtx = ctx;
            await ctx.stream.writeSSE({ event: "ready", data: "1" });
          },
          { scope, safetyTimeoutMs: 0 },
        ),
    );

    const { server, base } = serve(app);
    const response = await fetch(`${base}/events`);
    const reader = response.body!.getReader();
    await reader.read();
    const operation = streamCtx!.run(async () => {
      opStarted.resolve();
      await releaseOp.promise;
      events.push("op:end");
    });
    await opStarted.promise;

    const reportPromise = performShutdown({
      http: { name: "http", shutdown: () => server.shutdown() },
      tasks: createManagedTaskGroup(),
      connections: {
        name: "sse-streams",
        closeAll: () => scope.closeAll(),
        doneAll: () => scope.doneAll(),
      },
      resources: [{
        name: "db",
        close: () => {
          events.push("close:db");
        },
      }],
      httpTimeoutMs: 5_000,
      tasksTimeoutMs: 1_000,
      connectionsTimeoutMs: 5_000,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assertEquals(events.includes("op:end"), false);
    assertEquals(events.includes("close:db"), false);

    releaseOp.resolve();
    await operation;
    const report = await reportPromise;
    await readAll(reader);
    assertEquals(
      events.indexOf("op:end") < events.indexOf("close:db"),
      true,
      "依赖关闭必须发生在在途事件回调结束之后",
    );
    assertEquals(report.clean, true);
    assertEquals(report.connectionsSettled, true);
    assertEquals(scope.activeCount(), 0);
  },
});

Deno.test({
  name: "sse-shutdown: run 回调失败会 fail-closed 关闭流，关闭后拒绝新回调",
  sanitizeOps: STRICT_RESOURCE_SANITIZER,
  sanitizeResources: STRICT_RESOURCE_SANITIZER,
  async fn() {
    const scope = createSseStreamScope();
    let streamCtx: SseStreamContext | undefined;
    const app = new Hono();
    app.get(
      "/events",
      (c) =>
        createSseStream(
          c,
          async (ctx) => {
            streamCtx = ctx;
            await ctx.stream.writeSSE({ event: "ready", data: "1" });
          },
          { scope, safetyTimeoutMs: 0 },
        ),
    );
    const { server, base } = serve(app);
    try {
      const response = await fetch(`${base}/events`);
      const reader = response.body!.getReader();
      await reader.read();

      await streamCtx!.run(() => {
        throw new Error("event callback failed");
      });
      const end = await reader.read();
      assertEquals(end.done, true);
      assertEquals(scope.activeCount(), 0);

      let ranAfterClose = false;
      await streamCtx!.run(() => {
        ranAfterClose = true;
      });
      assertEquals(ranAfterClose, false, "关闭后不得启动新 operation");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "sse-shutdown: close 后注册退订立即清理，关闭后的新流不会重新打开泄漏",
  sanitizeOps: STRICT_RESOURCE_SANITIZER,
  sanitizeResources: STRICT_RESOURCE_SANITIZER,
  async fn() {
    const scope = createSseStreamScope();
    const events: string[] = [];
    const app = new Hono();
    app.get(
      "/late",
      (c) =>
        createSseStream(
          c,
          (ctx) => {
            ctx.close();
            ctx.close();
            // close 之后才注册：必须立即执行，不能永久悬挂。
            ctx.onUnsubscribe(() => events.push("late-unsub"));
          },
          { scope, safetyTimeoutMs: 0 },
        ),
    );
    const { server, base } = serve(app);
    try {
      const response = await fetch(`${base}/late`);
      await readAll(response.body!.getReader());
      assertEquals(events.includes("late-unsub"), true);
      assertEquals(
        events.filter((event) => event === "late-unsub").length,
        1,
        "close 幂等，退订不得重复执行",
      );
      assertEquals(scope.activeCount(), 0);

      // 关闭 scope 后再发起新 SSE：仍应立即结束，不允许重新挂起。
      scope.closeAll();
      const again = await fetch(`${base}/late`);
      await readAll(again.body!.getReader());
      assertEquals(scope.activeCount(), 0);
    } finally {
      await server.shutdown();
    }
  },
});
