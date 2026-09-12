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

Deno.test("log-format: request_id 不被 *_id 通配规则误截断", () => {
  // 回归防线：`request_id` 以 `_id` 结尾，会被截断规则命中。
  // 但它的用途是跨服务串联同一次请求，截断即失效；
  // 契约 §1 已由 pretty 侧自行取前 8 字符控制展示长度。
  withEnv({ NOJ_ENV: "production" }, () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    assertEquals(
      redactValueByKey("request_id", uuid),
      uuid,
      "关联标识必须完整保留，否则生产环境无法串联请求",
    );
    // 同一通配规则下的业务实体 id 仍必须截断——例外只开给关联标识
    assertEquals(redactValueByKey("submission_id", uuid), "550e8400...");
    assertEquals(redactValueByKey("trace_id", uuid), "550e8400...");
  });
});

Deno.test("log-format: JSON 输出中 request_id 完整可串联", () => {
  withEnv({ NOJ_ENV: "production" }, () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const records = capture((emit) =>
      emit("warn", "带上下文的日志 {n}", { n: 1 })
    );
    const rendered = JSON.parse(
      makeJsonFormatter()({ ...records[0]!, properties: { request_id: uuid } }),
    ) as { request_id?: string };
    assertEquals(rendered.request_id, uuid);
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

Deno.test("log-format: 业务字段不覆盖 JSON 信封保留键", () => {
  // 回归防线：字段区用展开运算铺开，名为 msg/level/ts 的业务字段
  // 会把信封本身覆盖掉——一条 logger.info("x", { msg }) 即可抹掉消息体。
  const records = capture((emit) =>
    emit("warn", "真实消息", {
      msg: "假的",
      level: "假的",
      ts: "假的",
      keep: 1,
    })
  );
  const parsed = JSON.parse(makeJsonFormatter()(records[0]!)) as Record<
    string,
    unknown
  >;
  assertEquals(parsed.msg, "真实消息");
  assertEquals(parsed.level, "warn");
  assertStrictEquals(
    parsed.ts === "假的",
    false,
    "ts 必须是真实时间戳，不能被业务字段覆盖",
  );
  assertEquals(parsed.field_msg, "假的", "冲突字段应改名保留而非丢弃");
  assertEquals(parsed.field_level, "假的");
  assertEquals(parsed.keep, 1);
});

Deno.test("log-format: 嵌套对象内的敏感键也脱敏", () => {
  // 字段区按顶层键匹配，嵌套结构会整块直通。
  // 目前无生产调用点传嵌套值，但 Error 的 details/context 这类
  // 结构一旦出现就是明文泄露，故锁住该行为。
  withEnv({ NOJ_ENV: "production" }, () => {
    const redacted = redactValueByKey("payload", {
      password: "hunter2",
      api_key: "sk-SECRET",
      submission_id: "550e8400-e29b-41d4-a716-446655440000",
    });
    const text = JSON.stringify(redacted);
    assertStrictEquals(
      text.includes("hunter2"),
      false,
      "嵌套 password 必须脱敏",
    );
    assertStrictEquals(
      text.includes("sk-SECRET"),
      false,
      "嵌套 api_key 必须脱敏",
    );
    assertStrictEquals(
      text.includes("550e8400-e29b-41d4-a716-446655440000"),
      false,
      "嵌套 submission_id 必须截断",
    );
  });
});

Deno.test("log-format: 自引用结构 fail-closed（不死循环，不留明文）", () => {
  withEnv({ NOJ_ENV: "production" }, () => {
    const cyclic: Record<string, unknown> = { password: "hunter2" };
    cyclic.self = cyclic;
    const redacted = redactValueByKey("payload", cyclic);
    const text = JSON.stringify(redacted);
    assertStrictEquals(text.includes("hunter2"), false);
    assertStrictEquals(text.includes("circular"), true, "环应被占位符替代");
  });
});

Deno.test("log-format: 超深嵌套 fail-closed（不原样放行明文）", () => {
  withEnv({ NOJ_ENV: "production" }, () => {
    let deep: unknown = { password: "hunter2" };
    for (let i = 0; i < 10; i++) deep = { lvl: deep };
    const text = JSON.stringify(redactValueByKey("d", deep));
    assertStrictEquals(
      text.includes("hunter2"),
      false,
      "深度截断必须返回占位符而非原始子树（原样返回即泄露）",
    );
    assertStrictEquals(text.includes("max-depth"), true);
  });
});

Deno.test("log-format: 兄弟节点共享同一对象不被误判为环", () => {
  withEnv({ NOJ_ENV: "production" }, () => {
    const shared = { password: "hunter2" };
    const text = JSON.stringify(
      redactValueByKey("g", { a: shared, b: shared }),
    );
    assertStrictEquals(text.includes("hunter2"), false);
    assertStrictEquals(
      text.includes("circular"),
      false,
      "DAG 不是环，两个分支都应正常脱敏",
    );
  });
});
