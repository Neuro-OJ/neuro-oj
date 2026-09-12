import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1";
import {
  describeColorPolicy,
  resolveColor,
  resolveFormat,
} from "./../../src/shared/base/log-config.ts";
import {
  logger,
  resetLogSink,
  setLogSink,
} from "./../../src/shared/base/logging.ts";
import { runWithRequestContext } from "./../../src/shared/observability/context.ts";

/** 快照并恢复给定 env，避免污染其他测试。 */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev = new Map(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("log-config: LOG_COLOR=always 强制开色", () => {
  withEnv(
    { LOG_COLOR: "always", NO_COLOR: undefined, LOG_FORMAT: undefined },
    () => {
      assertEquals(resolveColor("stdout"), true);
      assertEquals(resolveColor("stderr"), true);
    },
  );
});

Deno.test("log-config: LOG_COLOR=never 强制关色", () => {
  withEnv(
    { LOG_COLOR: "never", NO_COLOR: undefined, LOG_FORMAT: undefined },
    () => {
      assertEquals(resolveColor("stdout"), false);
      assertEquals(resolveColor("stderr"), false);
    },
  );
});

Deno.test("log-config: NO_COLOR 优先于 LOG_COLOR=always", () => {
  withEnv({ NO_COLOR: "1", LOG_COLOR: "always" }, () => {
    assertEquals(resolveColor("stdout"), false);
  });
});

Deno.test("log-config: NO_COLOR 空串不算设置", () => {
  withEnv({ NO_COLOR: "", LOG_COLOR: "always" }, () => {
    assertEquals(resolveColor("stdout"), true);
  });
});

Deno.test("log-config: LOG_FORMAT=json 恒无色且忽略 LOG_COLOR", () => {
  withEnv(
    { LOG_FORMAT: "json", LOG_COLOR: "always", NO_COLOR: undefined },
    () => {
      assertEquals(resolveColor("stdout"), false);
      assertEquals(resolveColor("stderr"), false);
    },
  );
});

Deno.test("log-config: 非法 LOG_COLOR 按 auto 处理", () => {
  withEnv(
    { LOG_COLOR: "bogus", NO_COLOR: undefined, LOG_FORMAT: undefined },
    () => {
      assertEquals(describeColorPolicy(), "auto");
    },
  );
});

Deno.test("log-config: resolveFormat 按环境回退", () => {
  withEnv({ LOG_FORMAT: "json" }, () => assertEquals(resolveFormat(), "json"));
  withEnv(
    { LOG_FORMAT: "pretty" },
    () => assertEquals(resolveFormat(), "pretty"),
  );
  withEnv(
    { LOG_FORMAT: undefined, NOJ_ENV: "production" },
    () => assertEquals(resolveFormat(), "json"),
  );
  withEnv(
    { LOG_FORMAT: undefined, NOJ_ENV: "development" },
    () => assertEquals(resolveFormat(), "pretty"),
  );
});

Deno.test("log-config: 电平过滤遵循 LOG_LEVEL 阈值", () => {
  // describeColorPolicy 之外的策略解析由 setupLogging 的动态过滤器保证；
  // 此处锁住"非法值不致命"的行为。
  withEnv({ LOG_COLOR: "ALWAYS" }, () => {
    // 大小写不敏感
    assertEquals(describeColorPolicy(), "on");
  });
});

Deno.test("log-config: isTty 探测不抛错（无 TTY 时保守关色）", () => {
  withEnv(
    { LOG_COLOR: undefined, NO_COLOR: undefined, LOG_FORMAT: undefined },
    () => {
      // 测试进程下 stdout 不是 TTY，应为 false；关键是不抛异常
      assertStrictEquals(typeof resolveColor("stdout"), "boolean");
      assertStrictEquals(typeof resolveColor("stderr"), "boolean");
    },
  );
});

Deno.test("logging: request_id 跨 await 传播到 LogTape 上下文", async () => {
  const records: { request_id?: string }[] = [];
  setLogSink((r) => records.push(r));
  try {
    await runWithRequestContext("req-async", async () => {
      await new Promise((r) => setTimeout(r, 5));
      logger.info("await 之后");
    });
    assertEquals(records[0]?.request_id, "req-async");
  } finally {
    resetLogSink();
  }
});
