/**
 * 网关 logger 与 request 上下文测试。
 *
 * 重点覆盖两件事：
 * 1. 契约布局 / 着色策略 / 脱敏规则；
 * 2. **修复的泄露缺陷**——eval_token 多来源 IP 告警不得明文写入
 *    submission_id 与客户端 IP（迁移前是裸 `console.warn` 模板字符串）。
 *
 * 测试策略：不手工伪造 `LogRecord`（其 `message` / `rawMessage` / `properties`
 * 三者必须自洽，手写极易造出真实运行时不可能出现的形状）。改为**真实调用
 * LogTape** 并用捕获 sink 取回记录，从而验证真实交互而非 mock 假设。
 */

import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import {
  configureSync,
  getLogger,
  type LogRecord as LtRecord,
  type Sink,
} from "@logtape/logtape";
import {
  formatPretty,
  makeGatewayJsonFormatter,
  makeGatewayPrettyFormatter,
  redactFields,
  resolveColor,
  resolveFormat,
  toCoreLevel,
} from "../src/logger.ts";
import {
  gatewayContextStorage,
  getRequestId,
  runWithRequestId,
} from "../src/context.ts";

/** 在受控 env 下执行 `fn`（自动还原）。 */
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

/** 装配捕获 sink，返回收集到的真实 LogTape 记录。 */
function capture(
  emit: (log: ReturnType<typeof getLogger>) => void,
): LtRecord[] {
  const seen: LtRecord[] = [];
  const sink: Sink = (r) => seen.push(r as LtRecord);
  configureSync({
    reset: true,
    sinks: { cap: sink },
    contextLocalStorage: gatewayContextStorage,
    loggers: [
      { category: [], sinks: ["cap"], lowestLevel: "trace" },
      // meta logger 会干扰捕获，静音
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "fatal" },
    ],
  });
  emit(getLogger(["noj", "llm-gateway"]));
  return seen;
}

Deno.test("formatPretty 产出契约布局（时间戳 + 定宽徽章 + msg + 字段平铺）", () => {
  const [record] = capture((log) => {
    log.info("评测任务入队", { request_id: "550e8400aa", queue_length: 3 });
  });
  const line = formatPretty(
    { timestamp: "14:32:07.412", record: record! },
    { color: false },
  );
  assertEquals(
    line,
    "14:32:07.412  INFO   评测任务入队  rid=550e8400  queue_length=3",
  );
});

Deno.test("formatPretty 着色时使用契约 SGR（dim 时间戳 / 级别色 / 粗体整行）", () => {
  const [info] = capture((log) => log.info("启动"));
  const infoLine = formatPretty(
    { timestamp: "14:32:07.412", record: info! },
    { color: true },
  );
  assertStringIncludes(infoLine, "\x1b[2m14:32:07.412\x1b[0m");
  assertStringIncludes(infoLine, "\x1b[36mINFO \x1b[0m");

  const [warn] = capture((log) => log.warn("失败"));
  const warnLine = formatPretty(
    { timestamp: "14:32:07.412", record: warn! },
    { color: true },
  );
  // 用 endsWith 断言而非含 \x1b 的正则：deno lint 的 no-control-regex
  // 会拒绝正则里的控制字符（`\x1b`），字符串比较无此限制。
  assertEquals(warnLine.endsWith("\x1b[1m"), false);
  assertEquals(warnLine.startsWith("\x1b[1m"), true, "WARN 整行应额外粗体");
  assertEquals(warnLine.endsWith("\x1b[0m"), true, "整行粗体应以 reset 收尾");
  assertStringIncludes(warnLine, "\x1b[1;33m");
});

Deno.test("message 中的插值值按占位符名脱敏（生产不泄露完整 ID/IP）", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const [record] = capture((log) => {
    log.warn("eval_token 多来源 IP 调用 {submission_id} {client_ip}", {
      submission_id: uuid,
      client_ip: "203.0.113.7",
    });
  });
  withEnv({ NOJ_ENV: "production" }, () => {
    const line = formatPretty(
      { timestamp: "14:32:07.412", record: record! },
      { color: false },
    );
    assertEquals(
      line.includes(uuid),
      false,
      `完整 UUID 不得出现在日志中: ${line}`,
    );
    assertEquals(
      line.includes("203.0.113.7"),
      false,
      `明文 IP 不得出现在日志中: ${line}`,
    );
    // 但仍保留可识别前缀
    assertStringIncludes(line, "550e8400...");
  });
});

Deno.test("redactFields：生产脱敏敏感键、截断 ID；开发保留原值", () => {
  const fields = {
    password: "hunter2",
    eval_token: "tok_live_abc",
    api_key: "sk-live-xyz",
    submission_id: "550e8400-e29b-41d4-a716-446655440000",
    client_ip: "203.0.113.7",
    queue_length: 3,
  };
  withEnv({ NOJ_ENV: "production" }, () => {
    const out = redactFields(fields);
    assertEquals(out.password, "[redacted]");
    assertEquals(out.eval_token, "[redacted]");
    assertEquals(out.api_key, "[redacted]");
    assertEquals(out.submission_id, "550e8400...");
    assertEquals(out.client_ip, "[redacted]");
    assertEquals(out.queue_length, 3);
  });
  withEnv({ NOJ_ENV: "development" }, () => {
    const out = redactFields(fields);
    assertEquals(out.password, "hunter2");
    assertEquals(out.submission_id, "550e8400-e29b-41d4-a716-446655440000");
  });
});

Deno.test("字段去重只发生在 pretty 呈现层；JSON 与 properties 保留全字段", () => {
  const [record] = capture((log) => {
    log.info("提交 {submission_id}", { submission_id: "abc", extra: 1 });
  });
  // 契约 §2：pretty 字段区必须排除已插值进 message 的键（否则同字段出现两次）
  const pretty = makeGatewayPrettyFormatter({ color: false })(record!);
  assertStringIncludes(pretty, "提交 abc");
  assertEquals(
    pretty.includes("submission_id="),
    false,
    `pretty 字段区不得重复已插值键: ${pretty}`,
  );
  assertStringIncludes(pretty, "extra=1");

  // JSON 是结构化输出，保留全部字段（与 noj-core 的 makeJsonFormatter 同构）
  const parsed = JSON.parse(makeGatewayJsonFormatter()(record!));
  assertEquals(parsed.submission_id, "abc");
  assertEquals(parsed.extra, 1);
  assertStringIncludes(parsed.msg, "abc");

  // 原始 properties 未被破坏（兼容层与既有断言依赖它）
  assertEquals(record!.properties.submission_id, "abc");
});

Deno.test("JSON formatter 形状契约（ts/level/msg/字段平铺、无 properties 嵌套）", () => {
  const [record] = capture((log) => {
    log.info("入队", { request_id: "rid-1", limit: 10 });
  });
  const parsed = JSON.parse(makeGatewayJsonFormatter()(record!));
  assertEquals(parsed.level, "info");
  assertEquals(parsed.msg, "入队");
  assertEquals(parsed.request_id, "rid-1");
  assertEquals(parsed.limit, 10);
  assertEquals("properties" in parsed, false);
  assertMatch(parsed.ts, /^\d{4}-\d{2}-\d{2}T/);
});

Deno.test("resolveColor 优先级：NO_COLOR > LOG_COLOR > TTY，json 恒无色", () => {
  withEnv({ NO_COLOR: "1", LOG_COLOR: "always", LOG_FORMAT: "pretty" }, () => {
    assertEquals(resolveColor("stdout"), false);
  });
  withEnv(
    { NO_COLOR: undefined, LOG_COLOR: "never", LOG_FORMAT: "pretty" },
    () => {
      assertEquals(resolveColor("stdout"), false);
    },
  );
  withEnv(
    { NO_COLOR: undefined, LOG_COLOR: "always", LOG_FORMAT: "pretty" },
    () => {
      assertEquals(resolveColor("stdout"), true);
    },
  );
  withEnv(
    { NO_COLOR: undefined, LOG_COLOR: "always", LOG_FORMAT: "json" },
    () => {
      // json 优先于一切开关：防止 ANSI 写进结构化日志流
      assertEquals(resolveColor("stdout"), false);
    },
  );
});

Deno.test("resolveFormat 按环境回退（生产 json，否则 pretty）", () => {
  withEnv({ LOG_FORMAT: undefined, NOJ_ENV: "production" }, () => {
    assertEquals(resolveFormat(), "json");
  });
  withEnv({ LOG_FORMAT: undefined, NOJ_ENV: "development" }, () => {
    assertEquals(resolveFormat(), "pretty");
  });
  withEnv({ LOG_FORMAT: "pretty", NOJ_ENV: "production" }, () => {
    assertEquals(resolveFormat(), "pretty");
  });
});

Deno.test("toCoreLevel 映射 LogTape 级别名（warning → warn）", () => {
  assertEquals(toCoreLevel("warning"), "warn");
  assertEquals(toCoreLevel("warn"), "warn");
  assertEquals(toCoreLevel("trace"), "debug");
  assertEquals(toCoreLevel("fatal"), "error");
  assertEquals(toCoreLevel("info"), "info");
});

Deno.test("request 上下文：runWithRequestId 内可取到，外部 undefined", async () => {
  assertEquals(getRequestId(), undefined);
  const seen = await runWithRequestId("rid-abc", () => getRequestId());
  assertEquals(seen, "rid-abc");
  assertEquals(getRequestId(), undefined);
});

Deno.test("request_id 自动附加到日志行（rid 截断 8 位）", () => {
  const [record] = capture((log) => {
    log.info("调用", { request_id: "abcdefgh-1234" });
  });
  const line = formatPretty(
    { timestamp: "14:32:07.412", record: record! },
    { color: false },
  );
  assertStringIncludes(line, "rid=abcdefgh");
  assertEquals(line.includes("abcdefgh-1234"), false);
});

Deno.test("pretty formatter 无色输出不含 ANSI，且含结构化字段", () => {
  const [record] = capture((log) => {
    log.info("入队 {submission_id}", { submission_id: "abc", q: 2 });
  });
  const out = makeGatewayPrettyFormatter({ color: false })(record!);
  assertEquals(out.includes("\x1b["), false);
  assertStringIncludes(out, "INFO ");
  assertStringIncludes(out, "入队");
  assertStringIncludes(out, "q=2");
});

Deno.test("setupGatewayLogging 幂等可重复装配，且上下文 request_id 自动注入", async () => {
  const { setupGatewayLogging, logger } = await import("../src/logger.ts");
  // 重复装配不得抛（内部 reset: true）
  setupGatewayLogging();
  setupGatewayLogging();

  const seen: LtRecord[] = [];
  const sink: Sink = (r) => seen.push(r as LtRecord);
  configureSync({
    reset: true,
    sinks: { cap: sink },
    contextLocalStorage: gatewayContextStorage,
    loggers: [
      { category: [], sinks: ["cap"], lowestLevel: "trace" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "fatal" },
    ],
  });

  logger.info("测试事件", { k: 1 });
  assertEquals(seen.length, 1);
  assertEquals(seen[0]!.properties.k, 1);

  // 上下文中的 request_id 应自动附加到记录
  await runWithRequestId("rid-ctx", () => {
    logger.warn("带上下文");
  });
  assertEquals(seen.length, 2);
  assertEquals(seen[1]!.properties.request_id, "rid-ctx");

  setupGatewayLogging();
});
