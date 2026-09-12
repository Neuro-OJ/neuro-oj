import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1";
import {
  configureSync,
  getLogger,
  type LogRecord as LtRecord,
  type Sink,
} from "@logtape/logtape";
import {
  fitModule,
  formatErrorDetail,
  isSerializedError,
  makeJsonFormatter,
  makePrettyFormatter,
  moduleName,
  orderedPlaceholders,
  redactValueByKey,
  renderableFields,
  renderableMessage,
  serializeValue,
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

/** SGR 转义起始符（ESC）；单独抽出以规避 lint 的 no-control-regex。 */
const ESC = String.fromCharCode(27);

/** 解析后的一段文本及其累计 SGR 状态。 */
interface ParsedSpan {
  text: string;
  /** 该段生效的原始参数串（如 "1;31"）；无样式为 ""。 */
  codes: string;
  bold: boolean;
  dim: boolean;
}

/**
 * 按 SGR 状态机解析一行，得到「每段文本实际带什么样式」。
 *
 * 必要性：断言「行首是否有 `\x1b[1m`」**无法**证明整行粗体生效——旧实现
 * 恰好满足该断言却完全没生效（外层 bold 被行内 reset 清掉）。只有模拟
 * 终端的状态机才能测到这个缺陷。
 */
function sgrSpans(line: string): ParsedSpan[] {
  const spans: ParsedSpan[] = [];
  const active = new Set<string>();
  // 用 RegExp 构造 + 字符串转义，规避 lint 的 no-control-regex（\x1b 是
  // SGR 序列的必要组成部分，其状态机语义无法用无转义的正则表达）。
  const re = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (t: string) => {
    if (t.length === 0) return;
    const codes = [...active].join(";");
    spans.push({
      text: t,
      codes,
      bold: active.has("1"),
      dim: active.has("2"),
    });
  };
  while ((m = re.exec(line))) {
    push(line.slice(last, m.index));
    last = m.index + m[0].length;
    const codes = m[1]!.split(";").filter((c) => c.length > 0);
    if (codes.length === 0 || codes.includes("0")) {
      active.clear();
      continue;
    }
    for (const c of codes) active.add(c);
  }
  push(line.slice(last));
  return spans;
}

/**
 * 判断一行在结束时是否仍处于「已开样式」状态（样式泄漏）。
 *
 * 用状态机而非正则：`\x1b[1m ... \x1b[0m` 是合法的成对写法，只有
 * 「开了没关」才是缺陷。
 */
function hasUnclosedSgr(line: string): boolean {
  // 用 RegExp 构造 + 字符串转义，规避 lint 的 no-control-regex（\x1b 是
  // SGR 序列的必要组成部分，其状态机语义无法用无转义的正则表达）。
  const re = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");
  let active = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const codes = m[1]!.split(";").filter((c) => c.length > 0);
    if (codes.length === 0 || codes.includes("0")) active = 0;
    else active += codes.length;
  }
  return active > 0;
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
  // 时间戳 HH:MM:SS.mmm（12）+ 2 + 级别 padEnd(5)（"INFO "）+ 2
  // + 模块 padEnd(14) + 2 = msg 起始第 37 列（0-based 36）。
  // 整行精确断言：列宽/间距一旦漂移立即变红（用 includes 会漏掉布局回归）。
  const head = line.slice(0, 37);
  // 模块列取 category 末段；capture() 用 ["noj","test"]，故渲染为 "test"。
  // 列宽：12(ts) + 2 + 5(级别 "INFO ") + 2 + 14(模块) + 2 = 37；
  // 故 INFO 后 3 个空格（徽章自带 1 + 分隔 2），test 后 12 个空格。
  assertEquals(
    /^\d{2}:\d{2}:\d{2}\.\d{3} {2}INFO {3}test {12}$/.test(head),
    true,
    `列布局不符（msg 须从第 37 列开始）: ${JSON.stringify(head)}`,
  );
  assertEquals(
    line.slice(37),
    "入队 550e8400-e29b-41d4-a716-446655440000  queue_length=3",
    `msg 区不符: ${JSON.stringify(line.slice(37))}`,
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
  const spans = sgrSpans(line);
  // ERROR 徽章：契约 §1 的复合码 1;31（行级粗体 1 + 级别色 31，前置合成）
  const badge = spans.find((s) => s.text === "ERROR");
  assertStrictEquals(badge?.codes, "1;31", "ERROR 徽章应为粗体红 1;31");
  // 整行粗体必须**真的覆盖 message**：这是历史缺陷的回归护栏。
  // 旧实现把 \x1b[1m 套在整行最外层，被行内第一个 \x1b[0m 清掉，
  // 导致 message 从未变粗（契约承诺未兑现）。
  const msg = spans.find((s) => s.text === "出错");
  assertStrictEquals(msg?.bold, true, "ERROR 整行粗体必须覆盖 message 本体");
  // WARN 不再整行粗体（决策：粗体为 ERROR 专属）
  const warnRec = capture((emit) => emit("warn", "警告", {}))[0]!;
  const warnLine = makePrettyFormatter({ color: true, production: false })(
    warnRec,
  ).trimEnd();
  const warnSpans = sgrSpans(warnLine);
  assertStrictEquals(
    warnSpans.find((s) => s.text.includes("警告"))?.bold,
    false,
    "WARN 不得整行粗体",
  );
  assertStrictEquals(
    warnSpans.find((s) => s.text.trim() === "WARN")?.codes,
    "33",
    "WARN 徽章为黄色 33",
  );
  // 任何片段都必须自带 reset：行内样式不得跨片段泄漏（judge 侧曾把
  // 粗体写在换行前且不带 reset，导致样式污染后续输出）。
  assertEquals(
    hasUnclosedSgr(line),
    false,
    "行尾不得留下未闭合的 SGR（样式会泄漏到后续输出）",
  );
});

Deno.test("log-format: 多行 msg 缩进到 msg 列", () => {
  const records = capture((emit) => emit("info", "第一行\n第二行", {}));
  const line = makePrettyFormatter({ color: false, production: false })(
    records[0]!,
  );
  const second = line.split("\n")[1]!;
  assertEquals(
    second,
    " ".repeat(37) + "第二行",
    `续行须缩进到 msg 起始列（37）: ${JSON.stringify(second)}`,
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

Deno.test("log-format: 模块列取 category 末段并按列宽截断", () => {
  const rec = (cat: string[]) => ({ category: cat }) as unknown as LtRecord;
  assertEquals(moduleName(rec(["noj", "submission"])), "submission");
  assertEquals(moduleName(rec(["noj", "dual", "container"])), "container");
  assertEquals(moduleName(rec(["noj", "core"])), "core");
  assertEquals(moduleName(rec([])), undefined, "空 category 无模块名");
  // 列宽 14：不足补空格，超宽截断加省略号（不得撑破列）
  assertEquals(fitModule("db"), "db".padEnd(14));
  assertEquals(fitModule("content-review"), "content-review");
  assertEquals("content-review".length, 14, "恰好 14 不截断");
  const long = fitModule("a-very-long-module-name");
  assertEquals(long.length, 14, "超宽必须截到列宽");
  assertEquals(long.endsWith("…"), true, "截断须有省略号提示");
});

Deno.test("log-format: 数值字段着色、字符串字段不着色", () => {
  const records = capture((emit) =>
    emit("info", "入队", { queue_length: 3, channel: "events" })
  );
  const line = makePrettyFormatter({ color: true, production: false })(
    records[0]!,
  ).trimEnd();
  const spans = sgrSpans(line);
  // 数值 magenta 35，与字符串值区分（长行里便于扫读数字）
  assertStrictEquals(
    spans.find((s) => s.text === "3")?.codes,
    "35",
    "数值字段应为 magenta 35",
  );
  assertStrictEquals(
    spans.find((s) => s.text === "events")?.codes,
    "",
    "字符串字段应保持默认色",
  );
  // 无色模式下数值不得引入转义
  const plain = makePrettyFormatter({ color: false, production: false })(
    capture((emit) => emit("info", "入队", { queue_length: 3 }))[0]!,
  );
  assertStrictEquals(plain.includes("\x1b["), false);
});

Deno.test("log-format: Error 展开为多行详情块而非压行 JSON", () => {
  const err = new Error("connection terminated unexpectedly");
  const records = capture((emit) => emit("error", "写入失败", { error: err }));
  const line = makePrettyFormatter({ color: false, production: false })(
    records[0]!,
  );
  // 不得出现 JSON 压行（stack 换行被转义成字面 \n 后整行不可读）
  assertStrictEquals(
    line.includes('{"name"'),
    false,
    "Error 不得渲染为 JSON 压行",
  );
  const lines = line.trimEnd().split("\n");
  assertStrictEquals(lines.length > 1, true, "Error 应展开为多行");
  assertStrictEquals(
    lines[1]!.startsWith(" ".repeat(37)),
    true,
    `详情块须缩进到 msg 列: ${JSON.stringify(lines[1])}`,
  );
  assertStrictEquals(
    lines[1]!.includes("error: connection terminated unexpectedly"),
    true,
  );
});

Deno.test("log-format: 序列化 Error 标记对 JSON 形状不可见", () => {
  const tagged = serializeValue(new Error("boom")) as Record<string, unknown>;
  assertStrictEquals(isSerializedError(tagged), true);
  // 不可枚举：JSON.stringify 与 Object.entries 都不得看到标记
  const json = JSON.stringify(tagged);
  assertStrictEquals(json.includes("Symbol"), false, "标记不得进入 JSON");
  assertStrictEquals(
    Object.keys(tagged).includes("Symbol(noj.log.serialized-error)"),
    false,
  );
  // 非 Error 值不得被误判
  assertStrictEquals(isSerializedError({ name: "Error", message: "x" }), false);
  assertStrictEquals(isSerializedError("boom"), false);
  assertStrictEquals(isSerializedError(null), false);
});

Deno.test("log-format: 生产环境下 Error 标记在脱敏后仍保留", () => {
  withEnv({ NOJ_ENV: "production" }, () => {
    // 脱敏会走 serializeValue → redactNested 重建对象，标记必须补回，
    // 否则递归脱敏后的 Error 又退回「认不出的普通对象」。
    const after = redactValueByKey("error", new Error("boom"));
    assertStrictEquals(
      isSerializedError(after),
      true,
      "生产脱敏后仍须能识别 Error 形状",
    );
    const records = capture((emit) =>
      emit("error", "失败", { error: new Error("boom"), email: "a@b.com" })
    );
    const line = makePrettyFormatter({ color: false, production: true })(
      records[0]!,
    );
    assertStrictEquals(line.includes('{"name"'), false);
    assertStrictEquals(line.includes("error: boom"), true);
    assertStrictEquals(line.includes("a@b.com"), false, "敏感键仍须脱敏");
  });
});

Deno.test("log-format: formatErrorDetail 去掉与首行重复的 stack 首行", () => {
  const err = new Error("boom");
  const detail = formatErrorDetail(
    "error",
    serializeValue(err) as Record<string, unknown>,
  );
  const lines = detail.split("\n");
  assertStrictEquals(lines[0], "error: boom");
  // stack 首行是 "Error: boom"，与 head 重复，必须剔除
  assertStrictEquals(
    lines.filter((l) => l.includes("error: boom") || l.includes("Error: boom"))
      .length,
    1,
    `stack 首行不应重复: ${JSON.stringify(detail)}`,
  );
  for (const l of lines.slice(1)) {
    assertStrictEquals(
      l.startsWith("  at "),
      true,
      `栈帧格式: ${JSON.stringify(l)}`,
    );
  }
});

Deno.test("log-format: 无色模式的 Error 块不得含未闭合 SGR", () => {
  const records = capture((emit) =>
    emit("error", "失败", { error: new Error("x") })
  );
  const line = makePrettyFormatter({ color: false, production: false })(
    records[0]!,
  );
  assertStrictEquals(line.includes("\x1b["), false, "无色模式零转义");
});
