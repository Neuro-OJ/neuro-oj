import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1";
import {
  configureSync,
  getLogger,
  type LogRecord as LtRecord,
  type Sink,
} from "@logtape/logtape";
import {
  makeJsonFormatter,
  makePrettyFormatter,
  orderedPlaceholders,
  redactValueByKey,
  renderableFields,
  renderableMessage,
  toCoreLevel,
  toLogTapeLevel,
} from "./../../src/shared/base/log-format.ts";

/** 捕获 LogTape 原始记录，供 formatter 单测。 */
function capture(
  fn: (
    emit: (lvl: string, msg: string, props: Record<string, unknown>) => void,
  ) => void,
): LtRecord[] {
  const seen: LtRecord[] = [];
  const sink: Sink = (r) => {
    seen.push(r);
  };
  configureSync({
    reset: true,
    sinks: { cap: sink },
    filters: {},
    loggers: [
      { category: [], sinks: ["cap"], lowestLevel: "trace" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "fatal" },
    ],
  });
  const log = getLogger(["noj", "test"]);
  fn((lvl, msg, props) => {
    if (lvl === "warn") log.warn(msg, props);
    else if (lvl === "error") log.error(msg, props);
    else if (lvl === "debug") log.debug(msg, props);
    else log.info(msg, props);
  });
  return seen;
}

/** 快照并恢复 NOJ_ENV，避免污染其他测试。 */
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

Deno.test("log-format: 级别名映射（warn ↔ warning）", () => {
  assertEquals(toLogTapeLevel("warn"), "warning");
  assertEquals(toLogTapeLevel("info"), "info");
  assertEquals(toCoreLevel("warning"), "warn");
  assertEquals(toCoreLevel("trace"), "debug");
  assertEquals(toCoreLevel("fatal"), "error");
});

Deno.test("log-format: orderedPlaceholders 保序含重复", () => {
  assertEquals(orderedPlaceholders("入队 {a} 队列 {b}"), ["a", "b"]);
  assertEquals(orderedPlaceholders("重复 {x} 与 {x}"), ["x", "x"]);
  assertEquals(orderedPlaceholders("转义 {{a}} 不算"), []);
  assertEquals(orderedPlaceholders("无占位符"), []);
});

Deno.test("log-format: pretty 无色输出零转义且布局符合契约", () => {
  const records = capture((emit) => {
    // 只把 submission_id 插值进 message；queue_length 留在字段区
    emit("info", "入队 {submission_id}", {
      submission_id: "550e8400-e29b-41d4-a716-446655440000",
      queue_length: 3,
    });
  });
  const fmt = makePrettyFormatter({ color: false, production: false });
  // formatter 会带行尾换行（getTextFormatter 的约定），断言时去掉
  const line = fmt(records[0]!).trimEnd();
  assertStrictEquals(line.includes("\x1b["), false, "无色模式不得含转义序列");
  // 时间戳 HH:MM:SS.mmm（12 字符）+ 2 空格 + 级别（padEnd(5)）+ 2 空格。
  // INFO 被 padEnd 成 "INFO "，再加 2 空格分隔，故 INFO 后共 3 个空格。
  assertEquals(
    /^\d{2}:\d{2}:\d{2}\.\d{3} {2}INFO {3}/.test(line),
    true,
    `布局不符: ${JSON.stringify(line)}`,
  );
  assertEquals(
    line.includes("入队 550e8400-e29b-41d4-a716-446655440000"),
    true,
  );
  // 已插值的 submission_id 不得在字段区重复出现（去重只发生在呈现层）
  assertEquals(
    line.includes("submission_id="),
    false,
    "插值键不应重复渲染在字段区",
  );
  // 未插值的 queue_length 必须出现在字段区
  assertEquals(line.includes("queue_length=3"), true);
});

Deno.test("log-format: pretty 有色输出含契约 SGR", () => {
  const records = capture((emit) => emit("error", "出错", { x: 1 }));
  const line = makePrettyFormatter({ color: true, production: false })(
    records[0]!,
  )
    .trimEnd();
  assertEquals(line.includes("\x1b[1;31m"), true, "ERROR 应为粗体红");
  assertEquals(line.startsWith("\x1b[1m"), true, "WARN/ERROR 整行粗体");
  assertEquals(line.endsWith("\x1b[0m"), true);
});

Deno.test("log-format: 多行 msg 缩进到 msg 列", () => {
  const records = capture((emit) => emit("info", "第一行\n第二行", {}));
  const line = makePrettyFormatter({ color: false, production: false })(
    records[0]!,
  );
  const second = line.split("\n")[1]!;
  assertEquals(
    second.startsWith(" ".repeat(21) + "第二行"),
    true,
    `实际: ${JSON.stringify(second)}`,
  );
});

Deno.test("log-format: 生产环境消息插值位置也脱敏", () => {
  withEnv({ NOJ_ENV: "production" }, () => {
    const records = capture((emit) => {
      emit("info", "提交 {submission_id} 完成", {
        submission_id: "550e8400-e29b-41d4-a716-446655440000",
      });
    });
    const formatted = makeJsonFormatter()(records[0]!);
    const parsed = JSON.parse(formatted) as {
      msg: string;
      submission_id: string;
    };
    assertEquals(parsed.msg, "提交 550e8400... 完成", "msg 内的插值必须脱敏");
    assertEquals(parsed.submission_id, "550e8400...");
  });
});

Deno.test("log-format: 生产环境敏感键整值抹除", () => {
  withEnv({ NOJ_ENV: "production" }, () => {
    assertEquals(redactValueByKey("email", "a@b.com"), "[redacted]");
    assertEquals(redactValueByKey("api_key", "sk-123"), "[redacted]");
    assertEquals(redactValueByKey("score", 9500), "[redacted]");
    assertEquals(redactValueByKey("status", "ok"), "ok");
  });
});

Deno.test("log-format: 开发环境不脱敏", () => {
  withEnv({ NOJ_ENV: "development" }, () => {
    const full = "550e8400-e29b-41d4-a716-446655440000";
    assertEquals(redactValueByKey("submission_id", full), full);
  });
});

Deno.test("log-format: JSON 形状与既有契约兼容", () => {
  const records = capture((emit) => emit("warn", "警告 {a}", { a: 1, b: 2 }));
  const parsed = JSON.parse(makeJsonFormatter()(records[0]!)) as Record<
    string,
    unknown
  >;
  assertEquals(parsed.level, "warn", "JSON level 用小写契约名");
  assertEquals(parsed.msg, "警告 1");
  assertEquals(parsed.a, 1);
  assertEquals(parsed.b, 2);
  assertEquals(typeof parsed.ts, "string");
  assertEquals("properties" in parsed, false, "字段应平铺而非嵌套");
  assertStrictEquals(JSON.stringify(parsed).includes("\x1b["), false);
});

Deno.test("log-format: renderableFields 排除插值键与 request_id", () => {
  const records = capture((emit) =>
    emit("info", "取 {a}", { a: 1, b: 2, request_id: "rid" })
  );
  assertEquals(renderableFields(records[0]!).map(([k]) => k), ["b"]);
  // 但 message 仍能渲染出 a 与 request_id 之外的信息
  assertEquals(renderableMessage(records[0]!).includes("1"), true);
});
