/**
 * 进程关闭协调器单元测试。
 *
 * 纯逻辑、零外部依赖：不连数据库/Redis，使用 deferred 假任务与短超时。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  createManagedTaskGroup,
  startPeriodicTask,
} from "../../../src/shared/runtime/managed-task.ts";
import {
  performShutdown,
  type ShutdownResource,
} from "../../../src/shared/runtime/shutdown.ts";

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

function resource(
  name: string,
  events: string[],
): ShutdownResource {
  return {
    name,
    close: () => {
      events.push(`close:${name}`);
    },
  };
}

Deno.test("shutdown: 正常顺序为先停止 HTTP 与任务领取，任务结束后才关闭依赖", async () => {
  const events: string[] = [];
  const taskDone = deferred();
  const tasks = createManagedTaskGroup();
  tasks.add({
    name: "worker",
    stop: () => events.push("stop:worker"),
    done: taskDone.promise,
  });

  const reportPromise = performShutdown({
    http: {
      name: "http",
      shutdown: () => {
        events.push("http:shutdown");
      },
    },
    tasks,
    resources: [resource("db", events)],
    httpTimeoutMs: 100,
    tasksTimeoutMs: 100,
    resourceTimeoutMs: 100,
  });

  // 关键：HTTP 关闭与 stopAll 必须在任何 await 前同步发出。
  assertEquals(events, ["http:shutdown", "stop:worker"]);

  // 在途任务未结束前，依赖不得关闭。
  await Promise.resolve();
  assertEquals(events.includes("close:db"), false);

  taskDone.resolve();
  const report = await reportPromise;
  assertEquals(events, ["http:shutdown", "stop:worker", "close:db"]);
  assertEquals(report.clean, true);
  assertEquals(report.exitCode, 0);
  assertEquals(report.httpDrained, true);
  assertEquals(report.tasksSettled, true);
  assertEquals(report.resourcesClosed, true);
  assertEquals(report.forceExit, false);
  assertEquals(report.problems.length, 0);
});

Deno.test("shutdown: stopAll 抛错仍等待全部任务，再关闭依赖并以非零码结束", async () => {
  const events: string[] = [];
  const taskDone = deferred();
  const tasks = {
    stopAll: () => {
      events.push("stopAll");
      throw new Error("stop exploded");
    },
    doneAll: () => {
      events.push("doneAll");
      return taskDone.promise;
    },
  };

  const reportPromise = performShutdown({
    http: { name: "http", shutdown: () => {} },
    tasks,
    resources: [resource("db", events)],
    httpTimeoutMs: 100,
    tasksTimeoutMs: 100,
  });

  assertEquals(events, ["stopAll", "doneAll"]);
  await Promise.resolve();
  assertEquals(
    events.includes("close:db"),
    false,
    "stop 抛错后仍必须等待 doneAll",
  );

  taskDone.resolve();
  const report = await reportPromise;
  assertEquals(events, ["stopAll", "doneAll", "close:db"]);
  assertEquals(report.clean, false);
  assertEquals(report.exitCode !== 0, true);
  assertEquals(report.tasksSettled, true);
  assertEquals(report.resourcesClosed, true);
  assertEquals(report.forceExit, false);
  assertEquals(
    report.problems.some((p) => p.subject === "stopAll" && p.kind === "error"),
    true,
  );
});

Deno.test("shutdown: 单任务失败聚合为失败报告且退出码非零", async () => {
  const events: string[] = [];
  const tasks = createManagedTaskGroup();
  tasks.add({
    name: "broken-worker",
    stop: () => {},
    done: Promise.reject(new Error("worker crashed")),
  });

  const report = await performShutdown({
    http: { name: "http", shutdown: () => {} },
    tasks,
    resources: [resource("db", events)],
    httpTimeoutMs: 100,
    tasksTimeoutMs: 100,
  });

  assertEquals(report.clean, false);
  assertEquals(report.exitCode !== 0, true);
  assertEquals(report.tasksSettled, true, "失败任务也已 settle");
  assertEquals(report.resourcesClosed, true, "任务已结束后允许关闭依赖");
  assertEquals(report.forceExit, false);
  assertEquals(
    report.problems.some((p) =>
      p.kind === "error" && p.message.includes("worker crashed")
    ),
    true,
  );
});

Deno.test("shutdown: 后台任务超时绝不算成功，且跳过依赖关闭", async () => {
  const events: string[] = [];
  const never = new Promise<void>(() => {});
  const tasks = {
    stopAll: () => {},
    doneAll: () => never,
  };

  const report = await performShutdown({
    http: { name: "http", shutdown: () => {} },
    tasks,
    resources: [resource("db", events)],
    httpTimeoutMs: 100,
    tasksTimeoutMs: 20,
  });

  assertEquals(report.clean, false);
  assertEquals(report.exitCode !== 0, true);
  assertEquals(report.tasksSettled, false);
  assertEquals(report.resourcesClosed, false, "任务仍运行时不得关闭依赖");
  assertEquals(report.forceExit, true);
  assertEquals(events.includes("close:db"), false);
  assertEquals(
    report.problems.some((p) => p.phase === "tasks" && p.kind === "timeout"),
    true,
  );
});

Deno.test("shutdown: HTTP 排空超时不会被报告为已完成，也不关闭依赖", async () => {
  const events: string[] = [];
  const tasks = createManagedTaskGroup();
  const report = await performShutdown({
    http: {
      name: "http",
      shutdown: () => new Promise<void>(() => {}),
    },
    tasks,
    resources: [resource("redis", events), resource("db", events)],
    httpTimeoutMs: 20,
    tasksTimeoutMs: 100,
  });

  assertEquals(report.clean, false);
  assertEquals(report.httpDrained, false);
  assertEquals(report.forceExit, true);
  assertEquals(report.resourcesClosed, false);
  assertEquals(events, [], "HTTP 未排空时不得关闭 Redis/DB");
  assertEquals(
    report.problems.some((p) => p.phase === "http" && p.kind === "timeout"),
    true,
  );
});

Deno.test("shutdown: 长连接收尾超时不会被当成成功，且跳过依赖关闭", async () => {
  const events: string[] = [];
  const report = await performShutdown({
    http: { name: "http", shutdown: () => {} },
    tasks: createManagedTaskGroup(),
    connections: {
      name: "sse-streams",
      closeAll: () => 1,
      doneAll: () => new Promise<void>(() => {}),
    },
    resources: [resource("db", events)],
    httpTimeoutMs: 100,
    tasksTimeoutMs: 100,
    connectionsTimeoutMs: 20,
  });

  assertEquals(report.clean, false);
  assertEquals(report.connectionsSettled, false);
  assertEquals(report.forceExit, true);
  assertEquals(report.resourcesClosed, false);
  assertEquals(events, []);
  assertEquals(
    report.problems.some((p) =>
      p.phase === "connections" && p.kind === "timeout"
    ),
    true,
  );
});

Deno.test("shutdown: HTTP shutdown 同步抛错按未排空处理并跳过依赖", async () => {
  const events: string[] = [];
  const report = await performShutdown({
    http: {
      name: "http",
      shutdown: () => {
        throw new Error("listener already broken");
      },
    },
    tasks: createManagedTaskGroup(),
    resources: [resource("db", events)],
    httpTimeoutMs: 100,
    tasksTimeoutMs: 100,
  });

  assertEquals(report.httpDrained, false);
  assertEquals(report.forceExit, true);
  assertEquals(report.resourcesClosed, false);
  assertEquals(events, []);
  assertEquals(
    report.problems.some((p) => p.phase === "http" && p.kind === "error"),
    true,
  );
});

Deno.test("shutdown: 非法 timeout 参数抛 TypeError 而不是静默立即超时", async () => {
  await assertRejects(
    () =>
      performShutdown({
        http: { name: "http", shutdown: () => {} },
        tasks: createManagedTaskGroup(),
        resources: [],
        httpTimeoutMs: Number.NaN,
        tasksTimeoutMs: 100,
      }),
    TypeError,
    "httpTimeoutMs",
  );
});

Deno.test("shutdown: 依赖关闭失败会聚合问题并返回非零码", async () => {
  const events: string[] = [];
  const tasks = createManagedTaskGroup();
  const report = await performShutdown({
    http: { name: "http", shutdown: () => {} },
    tasks,
    resources: [
      {
        name: "db",
        close: () => {
          events.push("close:db");
          throw new Error("db close failed");
        },
      },
      {
        name: "redis",
        close: () => {
          events.push("close:redis");
        },
      },
    ],
    httpTimeoutMs: 100,
    tasksTimeoutMs: 100,
  });

  // 一个依赖失败不能阻止其余依赖继续关闭。
  assertEquals(events, ["close:db", "close:redis"]);
  assertEquals(report.clean, false);
  assertEquals(report.exitCode !== 0, true);
  assertEquals(report.resourcesClosed, false);
  assertEquals(report.forceExit, false);
  assertEquals(
    report.problems.some((p) =>
      p.phase === "resources" && p.message.includes("db close failed")
    ),
    true,
  );
});

/**
 * 纯 test:runtime 没有数据库资源时开启严格 sanitizer；共享测试进程可能持有
 * PostgreSQL 连接池，其资源不属于本测试但 Deno sanitizer 会归因到当前用例造成
 * 误报。因此仅在无 DATABASE_URL 的隔离运行时启用资源检查（行为断言始终保留）。
 */
const STRICT_RESOURCE_SANITIZER = !Deno.env.get("DATABASE_URL");

Deno.test({
  name: "shutdown: 周期任务 stop 后不再启动新轮次且等待在途、清理定时器",
  sanitizeOps: STRICT_RESOURCE_SANITIZER,
  sanitizeResources: STRICT_RESOURCE_SANITIZER,
  async fn() {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = deferred();
    const task = startPeriodicTask({
      name: "periodic-demo",
      intervalMs: 5,
      run: async () => {
        runs++;
        started.resolve();
        await gate;
      },
    });

    await started.promise;
    task.stop();
    const runsAtStop = runs;
    await new Promise<void>((r) => setTimeout(r, 20));
    assertEquals(runs, runsAtStop, "stop 之后不得出现新轮次");

    let doneSettled = false;
    task.done.then(() => {
      doneSettled = true;
    });
    await Promise.resolve();
    assertEquals(doneSettled, false, "在途轮次未结束时 done 不得提前 resolve");

    release();
    await task.done;
    assertEquals(doneSettled, true);
    assertEquals(runs, runsAtStop, "在途轮次结束后也不得再启动新轮次");
  },
});
