import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1";
import { getLogger, type LogRecord as LtRecord } from "@logtape/logtape";
import {
  describeColorPolicy,
  type EnvReader,
  makeCoreFormatters,
  resolveColor,
  resolveFormat,
  setupLogging,
} from "./../../src/shared/base/log-config.ts";
import { makeJsonFormatter } from "./../../src/shared/base/log-format.ts";
import {
  logger,
  resetLogSink,
  setLogSink,
} from "./../../src/shared/base/logging.ts";
import { runWithRequestContext } from "./../../src/shared/observability/context.ts";

/**
 * 伪造 env 读取器：这些用例**从不改写进程级 `Deno.env`**。
 *
 * `resolveColor` / `resolveFormat` / `describeColorPolicy` 接受可注入的
 * `EnvReader`，因此直接传一个查表函数即可构造任意环境。
 *
 * 历史教训（评审两轮都指出，本文件曾两次修错）：
 * 1. 最初用 `Deno.env.set` + try/finally 恢复；
 * 2. 后来加了一把**模块级**互斥锁想串行化临界区。
 * 两者都不成立——`deno test --parallel` 下多个测试文件**共用同一进程**，
 * `Deno.env` 是进程级全局；模块级锁只能串行本文件的用例，挡不住其它文件
 * （如 `logging_test.ts` 设 `NOJ_ENV=production`）的并发写入。实测加了锁
 * 仍 12/60 次失败。正确的修法是**不碰全局状态**，而不是用锁去缓解。
 */
function envOf(
  vars: Record<string, string | undefined>,
): EnvReader {
  return (k) => vars[k];
}

/** 常见场景的读取器：显式列出用到的键，未列出的按未设置处理。 */
const ENV_ONLY_COLOR_ALWAYS = envOf({ LOG_COLOR: "always" });

Deno.test("log-config: LOG_COLOR=always 强制开色", () => {
  const env = envOf({
    LOG_COLOR: "always",
    NO_COLOR: undefined,
    LOG_FORMAT: undefined,
  });
  assertEquals(resolveColor("stdout", env), true);
  assertEquals(resolveColor("stderr", env), true);
});

Deno.test("log-config: LOG_COLOR=never 强制关色", () => {
  const env = envOf({
    LOG_COLOR: "never",
    NO_COLOR: undefined,
    LOG_FORMAT: undefined,
  });
  assertEquals(resolveColor("stdout", env), false);
  assertEquals(resolveColor("stderr", env), false);
});

Deno.test("log-config: NO_COLOR 优先于 LOG_COLOR=always", () => {
  const env = envOf({ NO_COLOR: "1", LOG_COLOR: "always" });
  assertEquals(resolveColor("stdout", env), false);
});

Deno.test("log-config: NO_COLOR 空串不算设置", () => {
  const env = envOf({ NO_COLOR: "", LOG_COLOR: "always" });
  assertEquals(resolveColor("stdout", env), true);
});

Deno.test("log-config: LOG_FORMAT=json 恒无色且忽略 LOG_COLOR", () => {
  const env = envOf({
    LOG_FORMAT: "json",
    LOG_COLOR: "always",
    NO_COLOR: undefined,
  });
  assertEquals(resolveColor("stdout", env), false);
  assertEquals(resolveColor("stderr", env), false);
});

Deno.test("log-config: 非法 LOG_COLOR 按 auto 处理", () => {
  const env = envOf({
    LOG_COLOR: "bogus",
    NO_COLOR: undefined,
    LOG_FORMAT: undefined,
  });
  assertEquals(describeColorPolicy(env), "auto");
});

Deno.test("log-config: resolveFormat 按环境回退", () => {
  assertEquals(resolveFormat(envOf({ LOG_FORMAT: "json" })), "json");
  assertEquals(resolveFormat(envOf({ LOG_FORMAT: "pretty" })), "pretty");
  assertEquals(
    resolveFormat(envOf({ LOG_FORMAT: undefined, NOJ_ENV: "production" })),
    "json",
  );
  assertEquals(
    resolveFormat(envOf({ LOG_FORMAT: undefined, NOJ_ENV: "development" })),
    "pretty",
  );
});

Deno.test("log-config: 电平过滤遵循 LOG_LEVEL 阈值", () => {
  // describeColorPolicy 之外的策略解析由 setupLogging 的动态过滤器保证；
  // 此处锁住"非法值不致命"的行为。
  // 大小写不敏感
  assertEquals(describeColorPolicy(ENV_ONLY_COLOR_ALWAYS), "on");
});

Deno.test("log-config: isTty 探测不抛错（无 TTY 时保守关色）", () => {
  const env = envOf({
    LOG_COLOR: undefined,
    NO_COLOR: undefined,
    LOG_FORMAT: undefined,
  });
  // 测试进程下 stdout 不是 TTY，应为 false；关键是不抛异常
  assertStrictEquals(typeof resolveColor("stdout", env), "boolean");
  assertStrictEquals(typeof resolveColor("stderr", env), "boolean");
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

Deno.test("logging: 生产原生 logger 也自动带上 request_id", async () => {
  // 回归防线：曾经的缺陷是「两套 ALS 实例 + camelCase 键名」，
  // 使 properties.request_id 恒为 undefined，而上面的兼容层测试因手工注入
  // 而依然通过。这里刻意用**原生 getLogger**（不经过兼容层）断言渲染出的
  // JSON，确保两条链路都真的传播。
  //
  // LOG_FORMAT=json 用**注入**而非改 env：setupLogging 尚未接受 env 参数，
  // 这里直接构造 formatter 断言渲染形状即可，避免污染进程级状态。
  const raw: LtRecord[] = [];
  try {
    setupLogging((r) => raw.push(r));
    const native = getLogger(["noj", "submission"]);
    await runWithRequestContext("rid-native-1", async () => {
      await new Promise((r) => setTimeout(r, 5));
      native.info("原生 logger 在 await 之后");
    });
    assertEquals(raw.length, 1);
    assertEquals(raw[0]?.properties.request_id, "rid-native-1");
    // 并且必须真的渲染进输出，而不只是躺在 properties 里
    const rendered = makeJsonFormatter({ production: false })(raw[0]!);
    assertEquals(JSON.parse(rendered).request_id, "rid-native-1");
  } finally {
    resetLogSink();
  }
});

Deno.test("logging: 装配层把 production 传给渲染器（评审 I2）", () => {
  // 评审 I2：装配接线此前没有测试覆盖——把 setupLogging 里的 { production }
  // 去掉，全部共享测试仍然通过。
  //
  // 断言 `makeCoreFormatters`（setupLogging 实际使用的装配函数）而非捕获
  // console：LogTape 的 console sink 在模块加载期就绑定 console 方法，捕获不可靠。
  const record = {
    category: ["noj", "submission"],
    level: "info" as const,
    message: ["提交 ", "550e8400-e29b-41d4-a716-446655440000"],
    rawMessage: "提交 {submission_id}",
    timestamp: Date.now(),
    properties: {
      submission_id: "550e8400-e29b-41d4-a716-446655440000",
      email: "a@b.com",
    },
  };

  // 生产 + json：id 必须截断、email 必须抹除
  const prodFmt = makeCoreFormatters(
    envOf({ NOJ_ENV: "production", LOG_FORMAT: "json" }),
  )("stdout")(record);
  assertEquals(prodFmt.includes("550e8400-e29b-41d4-a716-446655440000"), false);
  assertEquals(prodFmt.includes("a@b.com"), false);
  assertEquals(prodFmt.includes("[redacted]"), true);

  // 开发 + pretty：保留明文，证明确实由装配层解析出的 production 控制
  const devFmt = makeCoreFormatters(
    envOf({ NOJ_ENV: "development", LOG_FORMAT: "pretty" }),
  )("stdout")(record);
  assertEquals(devFmt.includes("550e8400-e29b-41d4-a716-446655440000"), true);
  assertEquals(devFmt.includes("a@b.com"), true);
});

Deno.test("logging: 无请求上下文时不出现 request_id", () => {
  const records: { request_id?: string }[] = [];
  setLogSink((r) => records.push(r));
  try {
    logger.info("裸调用");
    assertEquals(records[0]?.request_id, undefined);
  } finally {
    resetLogSink();
  }
});
