/**
 * 资源关闭异常传播测试（P2a 补充）。
 *
 * 纯逻辑、零网络：数据库关闭使用最小 fake 句柄；Redis 关闭既有纯函数 fake，
 * 也有 `getRedis()` 的 lazyConnect 对象（覆盖方法后不建立连接）。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  closeDbForShutdown,
  closeDbResources,
} from "../../../src/shared/db/connection.ts";
import {
  closeRedisClientForShutdown,
  closeRedisForShutdown,
  getRedis,
  type RedisShutdownClient,
  resetRedisForTest,
} from "../../../src/shared/mq/connection.ts";
import { performShutdown } from "../../../src/shared/runtime/shutdown.ts";

Deno.test("resource-close: DB 客户端关闭成功", async () => {
  const events: string[] = [];
  await closeDbResources({
    endClient: () => {
      events.push("client");
    },
  });
  assertEquals(events, ["client"]);
});

Deno.test("resource-close: DB 客户端失败聚合原始错误", async () => {
  const events: string[] = [];
  const clientError = new Error("client end failed");
  const error = await closeDbResources({
    endClient: () => {
      events.push("client");
      throw clientError;
    },
  }).then(
    () => undefined,
    (reason: unknown) => reason,
  );

  assertEquals(events, ["client"]);
  assert(error instanceof AggregateError);
  assertEquals(error.errors.length, 1);
  assert(error.errors[0] === clientError);
  assert(error.message.includes("postgres-client"));
  assert(error.message.includes("client end failed"));
});

Deno.test("resource-close: DB 错误保持 AggregateError 结构", async () => {
  const events: string[] = [];
  const clientError = new Error("client end failed");
  const error = await closeDbResources({
    endClient: () => {
      events.push("client");
      throw clientError;
    },
  }).then(
    () => undefined,
    (reason: unknown) => reason,
  );

  assertEquals(events, ["client"]);
  assert(error instanceof AggregateError);
  assertEquals(error.errors.length, 1);
  assert(error.errors.includes(clientError));
  assert(error.message.includes("postgres-client"));
});

Deno.test("resource-close: 未初始化的 DB 关闭安全完成", async () => {
  await closeDbForShutdown();
});

Deno.test("resource-close: Redis quit 成功后不再 disconnect", async () => {
  const events: string[] = [];
  const client: RedisShutdownClient = {
    quit: () => {
      events.push("quit");
      return "OK";
    },
    disconnect: () => {
      events.push("disconnect");
    },
    off: (event) => {
      events.push(`off:${event}`);
    },
  };

  await closeRedisClientForShutdown(client, () => {});
  assertEquals(events, ["off:ready", "quit"]);
});

Deno.test("resource-close: Redis quit 失败后 disconnect 兜底成功视为完成", async () => {
  const events: string[] = [];
  const quitError = new Error("quit failed");
  const client: RedisShutdownClient = {
    quit: () => {
      events.push("quit");
      throw quitError;
    },
    disconnect: () => {
      events.push("disconnect");
      // 模拟 ioredis：同步 void。
    },
    off: (event) => {
      events.push(`off:${event}`);
    },
  };

  await closeRedisClientForShutdown(client, () => {});
  assertEquals(events, ["off:ready", "quit", "disconnect"]);
});

Deno.test("resource-close: Redis quit 与 disconnect 均失败时抛 AggregateError", async () => {
  const quitError = new Error("quit failed");
  const disconnectError = new Error("disconnect failed");
  const client: RedisShutdownClient = {
    quit: () => {
      throw quitError;
    },
    disconnect: () => {
      throw disconnectError;
    },
  };

  const error = await closeRedisClientForShutdown(client).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert(error instanceof AggregateError);
  assertEquals(error.errors.length, 2);
  assert(error.errors.includes(quitError));
  assert(error.errors.includes(disconnectError));
  assert(error.message.includes("quit"));
  assert(error.message.includes("disconnect"));
});

Deno.test("resource-close: ready 监听器移除失败不阻止 Redis 关闭", async () => {
  const events: string[] = [];
  const client: RedisShutdownClient = {
    quit: () => {
      events.push("quit");
      return "OK";
    },
    disconnect: () => {},
    off: () => {
      throw new Error("off failed");
    },
  };

  await closeRedisClientForShutdown(client, () => {});
  assertEquals(events, ["quit"]);
});

Deno.test("resource-close: closeRedisForShutdown 释放单例并传播双重失败", async () => {
  const redis = getRedis();
  const quitError = new Error("real quit failed");
  const disconnectError = new Error("real disconnect failed");
  redis.quit = () => {
    throw quitError;
  };
  redis.disconnect = () => {
    throw disconnectError;
  };

  try {
    const error = await closeRedisForShutdown().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    assert(error instanceof AggregateError);
    assert(error.errors.includes(quitError));
    assert(error.errors.includes(disconnectError));

    // 关闭入口已释放单例：再次 getRedis 必须返回新对象（lazyConnect，不联网）。
    const replacement = getRedis();
    assert(replacement !== redis);
    replacement.disconnect();
  } finally {
    resetRedisForTest();
  }
});

Deno.test("resource-close: performShutdown 捕获资源关闭失败且继续关闭其余资源", async () => {
  const events: string[] = [];
  const dbError = new Error("db close failed");
  const redisError = new Error("redis quit failed");
  const redisFallbackError = new Error("redis disconnect failed");

  const report = await performShutdown({
    http: { name: "http", shutdown: () => {} },
    tasks: {
      stopAll: () => {},
      doneAll: () => Promise.resolve(),
    },
    resources: [
      {
        name: "database",
        close: () =>
          closeDbResources({
            endClient: () => {
              events.push("db");
              throw dbError;
            },
          }),
      },
      {
        name: "redis",
        close: () =>
          closeRedisClientForShutdown({
            quit: () => {
              events.push("redis");
              throw redisError;
            },
            disconnect: () => {
              throw redisFallbackError;
            },
          }),
      },
      {
        name: "other",
        close: () => {
          events.push("other");
        },
      },
    ],
    httpTimeoutMs: 100,
    tasksTimeoutMs: 100,
    resourceTimeoutMs: 100,
  });

  assertEquals(events.sort(), ["db", "other", "redis"]);
  assertEquals(report.clean, false);
  assertEquals(report.exitCode !== 0, true);
  assertEquals(report.resourcesClosed, false);
  assertEquals(report.forceExit, false);
  assert(
    report.problems.some((problem) =>
      problem.phase === "resources" &&
      problem.subject === "database" &&
      problem.message.includes("db close failed")
    ),
  );
  assert(
    report.problems.some((problem) =>
      problem.phase === "resources" &&
      problem.subject === "redis" &&
      problem.message.includes("quit failed") &&
      problem.message.includes("disconnect failed")
    ),
  );
});

Deno.test("resource-close: performShutdown 在替代关闭成功后保持 clean", async () => {
  const report = await performShutdown({
    http: { name: "http", shutdown: () => {} },
    tasks: {
      stopAll: () => {},
      doneAll: () => Promise.resolve(),
    },
    resources: [
      {
        name: "database",
        close: () =>
          closeDbResources({
            endClient: () => {},
          }),
      },
      {
        name: "redis",
        close: () =>
          closeRedisClientForShutdown({
            quit: () => {
              throw new Error("quit failed");
            },
            disconnect: () => {},
          }),
      },
    ],
    httpTimeoutMs: 100,
    tasksTimeoutMs: 100,
    resourceTimeoutMs: 100,
  });

  assertEquals(report.clean, true);
  assertEquals(report.exitCode, 0);
  assertEquals(report.resourcesClosed, true);
  assertEquals(report.problems, []);
});

Deno.test("resource-close: closeDbResources 单点失败以 AggregateError 拒绝", async () => {
  await assertRejects(
    () =>
      closeDbResources({
        endClient: () => {
          throw new Error("fatal db end");
        },
      }),
    AggregateError,
    "fatal db end",
  );
});
