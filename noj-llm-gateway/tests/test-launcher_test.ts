import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1";
import {
  assertRedisPrefix,
  createRunPlan,
  databaseUrlFor,
  parseTestArgs,
  readTestEnvironment,
  redisPrefixPattern,
  runWithResourceCleanup,
} from "../scripts/test-launcher-logic.ts";

Deno.test("Gateway 测试启动器：缺少必需 PG/Redis 资源时失败", () => {
  assertThrows(
    () => readTestEnvironment({}),
    Error,
    "缺少必需环境变量",
  );
});

Deno.test("Gateway 测试启动器：PG 或 Redis 任一缺失都直接失败", () => {
  assertThrows(
    () =>
      readTestEnvironment({
        TEST_REDIS_URL: "redis://127.0.0.1:6379/0",
      }),
    Error,
    "TEST_PG_ADMIN_URL",
  );
  assertThrows(
    () =>
      readTestEnvironment({
        TEST_PG_ADMIN_URL: "postgres://127.0.0.1:5432/postgres",
      }),
    Error,
    "TEST_REDIS_URL",
  );
});

Deno.test("Gateway 测试启动器：拒绝没有 admin 数据库名的 PG URL", () => {
  assertThrows(
    () =>
      readTestEnvironment({
        TEST_PG_ADMIN_URL: "postgres://127.0.0.1",
        TEST_REDIS_URL: "redis://127.0.0.1:6379/0",
      }),
    Error,
    "必须显式包含 admin 数据库名",
  );
});

Deno.test("Gateway 测试启动器：Redis cleanup pattern 只能覆盖一个 run", () => {
  const first = createRunPlan("rfirst1");
  const second = createRunPlan("rsecond");
  assertEquals(redisPrefixPattern(first.redisPrefix), `${first.redisPrefix}*`);
  assertEquals(
    redisPrefixPattern(second.redisPrefix),
    `${second.redisPrefix}*`,
  );
  assertThrows(
    () => assertRedisPrefix("noj-gateway-test:rfirst1:*"),
    Error,
    "namespace 非法",
  );
  assertThrows(
    () => assertRedisPrefix("other-run:"),
    Error,
    "namespace 非法",
  );
});

Deno.test("Gateway 测试启动器：filter 可透传但不能开启同库并发或绕过入口", () => {
  assertEquals(
    parseTestArgs([
      "--filter",
      "Redis",
      "--fail-fast",
      "--reporter=dot",
      "--shuffle=42",
      "--trace-leaks",
    ]),
    [
      "--filter",
      "Redis",
      "--fail-fast",
      "--reporter=dot",
      "--shuffle=42",
      "--trace-leaks",
    ],
  );
  assertEquals(parseTestArgs(["--filter=Redis"]), ["--filter=Redis"]);
  assertThrows(
    () => parseTestArgs(["--parallel"]),
    Error,
    "拒绝 --parallel",
  );
  assertThrows(
    () => parseTestArgs(["tests/provider_throttle_test.ts"]),
    Error,
    "不接受路径参数",
  );
  for (
    const argument of [
      "--config=/tmp/other-deno.json",
      "--import-map",
      "--no-config",
      "--eval=process.exit(0)",
      "--allow-all",
      "--deny-net",
      "--jobs=1",
    ]
  ) {
    assertThrows(
      () => parseTestArgs([argument]),
      Error,
      "不允许或不识别参数",
    );
  }
  assertThrows(
    () => parseTestArgs(["--reporter=unknown"]),
    Error,
    "不支持 reporter",
  );
});

Deno.test("Gateway 测试启动器：child 失败仍先执行 cleanup", async () => {
  const events: string[] = [];
  await assertRejects(
    () =>
      runWithResourceCleanup(
        () => {
          events.push("child");
          return Promise.reject(new Error("child failed"));
        },
        () => {
          events.push("cleanup");
          return Promise.resolve();
        },
      ),
    Error,
    "child failed",
  );
  assertEquals(events, ["child", "cleanup"]);
});

Deno.test("Gateway 测试启动器：child 非零结果也执行 cleanup 后原样返回", async () => {
  const events: string[] = [];
  const exitCode = await runWithResourceCleanup(
    () => {
      events.push("child");
      return Promise.resolve(23);
    },
    () => {
      events.push("cleanup");
      return Promise.resolve();
    },
  );
  assertEquals(exitCode, 23);
  assertEquals(events, ["child", "cleanup"]);
});

Deno.test("Gateway 测试启动器：数据库名与 Redis namespace 均按 run 隔离", () => {
  const plan = createRunPlan("rtest123");
  assertEquals(plan.databaseName, "noj_gateway_test_rtest123");
  assertEquals(plan.redisPrefix, "noj-gateway-test:rtest123:");
  assertEquals(
    databaseUrlFor(
      "postgres://postgres@127.0.0.1:5432/postgres",
      plan.databaseName,
    ),
    "postgres://postgres@127.0.0.1:5432/noj_gateway_test_rtest123",
  );
});
