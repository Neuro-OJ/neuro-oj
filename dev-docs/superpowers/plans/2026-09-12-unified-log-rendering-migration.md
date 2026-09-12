# 统一日志渲染与 LogTape 迁移实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 noj-core / noj-judge / noj-llm-gateway / noj-cli 四个运行时的日志呈现层统一到同一份视觉契约，noj-core 全量迁移到 LogTape 2.3.4，并修掉三个既有缺陷（judge 向结构化日志流灌 ANSI、`noj-cli logs` 无条件着色、gateway 未脱敏泄露）。

**Architecture:** 两层结构——**契约层**是纯文档 + 静态校验（`dev-docs/engineering/log-conventions.md` + `scripts/check-log-migration.ts`）；**实现层**按运行时各建一个装配模块（core 用 `shared/base/log-config.ts`，gateway 用 `src/logger.ts`，judge 用 `src/logging.rs`，cli 用 `src/util/color.ts`）。core 的 `shared/base/logging.ts` 降级为兼容层：对外导出形状（`LogRecord`/`setLogSink`/`resetLogSink`/`redactId`）不变，内部换成 LogTape，使 8 个既有断言测试与 6 个引用文件零改动通过。

**Tech Stack:** Deno 2 + LogTape 2.3.4（JSR）、TypeScript Compiler API（`npm:typescript@5.9.2`，供 AST 静态校验）、Rust `tracing` + `tracing-subscriber` 0.3（**不新增 crate 依赖**）。

**Spec:** `dev-docs/superpowers/specs/2026-09-12-unified-log-rendering-design.md`

## Global Constraints

以下约束适用于**每一个**任务，不再逐条重复。

- 所有提交必须 GPG 签名；本地用 `jj`（`jj describe` + `jj new`），提交信息遵循 Conventional Commits（`<type>(<scope>): <中文描述>`），scope 取 `core`/`judge`/`root`。
- 搜索代码必须用 `rg`；**读源码一律用 `read` 工具**，不要经 bash 管道 `cat`/`rg` 读代码——本会话中 bash 管道多次把匹配文本替换成 `n`（`"\x1b[0m"` 显示为 `"n0m"`），足以造成误判。
- 禁止手工编辑 `_journal.json`、`deno.lock`、`Cargo.lock`。新增依赖后由 `deno task` / `cargo build` 自动更新 lock 属正常。
- 新环境变量必须登记对应模块的配置声明（core → `noj-core/src/shared/config/settings-registry.ts`；gateway → `noj-llm-gateway/src/config-registry.ts`）并同步 `.env.example`，且通过 `deno task check:env` 与 `deno task check:config-usage`。
- 测试必须使用项目规定命令，**禁止手拼 `deno test`**：
  - noj-core 共享层：`cd noj-core && bash scripts/test-shared.sh`
  - noj-core 按域：`cd noj-core && deno task test:domain <domain>`
  - noj-core 全量：`cd noj-core && deno task test`
  - noj-judge：`cd noj-judge && cargo nextest run --all-targets`（无 nextest 时 `cargo test`）
  - noj-llm-gateway：`cd noj-llm-gateway && deno task test`
  - noj-cli：`cd noj-cli && deno task test`
- 静态检查：`deno fmt` + `deno lint`（TS）；`cargo fmt` + `cargo clippy`（Rust，零 warning）。
- 非平凡变更需更新 `.agents/notes/implemented/`，通过 `deno run -A scripts/verify-agent-note-format.ts`。

### 已实测的 LogTape 2.3.4 行为（不得凭直觉改动）

以下每一条都在本会话中用可运行探针验证过。写错任意一条的后果是**静默错误**或**运行时崩溃**。

1. **`getLogger` 只接受单个数组参数。** `getLogger(["noj","submission"])` → category `["noj","submission"]`；`getLogger("noj","submission")` 的第二个参数被**静默忽略**，category 退化为 `["noj"]`。**全项目统一用数组形式。**
2. **级别字符串值是 `warning`，不是 `warn`。** `LogLevel` 为 `trace|debug|info|warning|error|fatal`。`lowestLevel: "warn"` 与 `parseLogLevel("warn")` 都会抛 `TypeError: Invalid log level`。注意方法名 `logger.warn(...)` 是**正确**的，只有级别**字符串**是 `warning`。
3. **`record.message` 是交错数组**（文本/值交替，长度恒为奇数），不是字符串。`record.rawMessage` 是未插值模板原文，类型 `string | TemplateStringsArray`。
4. **`getAnsiColorFormatter({ format })` 的 `format` 必须是函数** `(values: FormattedValues) => string`。传字符串会在 sink 内抛 `TypeError`，且**只记入 meta logger、主输出无任何痕迹**。本计划**不使用** `getAnsiColorFormatter`，统一用 `getTextFormatter` + 自定义 `format`。
5. **已插值的键仍保留在 `properties` 中。** 渲染字段区时必须排除，否则同一字段出现两次。
6. **Error 以对象引用保留在 `properties` 中**（`instanceof Error` 为真），但 `JSON.stringify` 得 `{}`。须自行转 `{name,message,stack}`。
7. **`withContext` 在未配置 `contextLocalStorage` 时静默不生效**（不抛错）。
8. **`configureSync` 重复调用抛 `ConfigError`**，必须传 `reset: true`。
9. **原生 `getJsonLinesFormatter()` 形状与 core 现状不兼容**（`@timestamp` / 大写级别 / `properties` 嵌套），JSON 侧必须自写 formatter。
10. **占位符语法宽松**：任何 `{...}` 都被消费（含 `{a, b}`、`{}`、`{中文}`），缺失键渲染为 `null`；`{{` 是转义。实测 core 现状**无**字面花括号。
11. **未声明的 category 回退到 root**（`category: []`）；已声明 category 的子类别**继承**其 `lowestLevel` 与 sinks。
12. **裸 `new AsyncLocalStorage()` 可直接用作 `contextLocalStorage`**，并且 core 现有的 `runWithRequestContext` 用 `store.run(...)` 即可让 LogTape 读到 `request_id`——**无需改用 `withContext`**。
13. **`getStreamSink()` 不能与 `configureSync()` 共用**——它返回带异步 disposer 的 sink，`configureSync` 会抛 `ConfigError: Async disposables cannot be used with configureSync()`。**必须用 `getConsoleSink()`**：它同步写出、在 `Deno.exit(1)` 下**不丢日志**（已实测），且内置按级别选择 `console.debug/info/warn/error`，因此 warn/error 天然走 stderr、info/debug 走 stdout。
14. **`getConsoleSink({ formatter })` 的 formatter 收到的是单条记录**，可在其中按 `record.level` 选择不同 formatter——这是"stdout 与 stderr 分别判定 TTY 着色"的实现方式。

### 已实测的 Rust 事实

13. **Rust 1.96 起 `std::env::set_var`/`remove_var` 是 `unsafe`**。因此所有读 env 的判定逻辑必须抽出**纯函数内核**（传入 `Option<&str>` / `bool`）以便测试，测试**不得**改进程环境。
14. `FormatEvent::format_event` 签名固定为 `(&self, ctx: &FmtContext<'_, S, N>, writer: Writer<'_>, event: &Event<'_>) -> fmt::Result`；`MakeWriter::make_writer_for(&'a self, meta: &Metadata<'_>)` 是**按级别选择输出流**的官方钩子。
15. `std::io::IsTerminal` 已在 Rust 1.70 稳定（`noj-judge/rust-toolchain.toml` 钉 1.96.1）。

---

### Task 1: 写视觉契约文档

**Files:**
- Create: `dev-docs/engineering/log-conventions.md`
- Modify: `dev-docs/engineering/README.md`（在文档索引中加入新条目）

**Interfaces:**
- Consumes: 无。
- Produces: 纯文档。后续所有任务的色值、布局、判定顺序**以本文档为准**，代码注释引用其小节号。

- [ ] **Step 1: 写契约文档**

创建 `dev-docs/engineering/log-conventions.md`：

````markdown
# 日志视觉契约

> 四个运行时（noj-core / noj-judge / noj-llm-gateway / noj-cli）的日志人读呈现规范。
> 本文档是**单一事实源**；代码中的 SGR 常量与布局必须与此处一致。

## 1. 颜色语义

| 语义 | SGR | 应用位置 |
|---|---|---|
| ERROR | `1;31` 粗体红 | 级别徽章 + 整行粗体 |
| WARN | `1;33` 粗体黄 | 级别徽章 + 整行粗体 |
| INFO | `36` 青 | 级别徽章 |
| DEBUG | `90` 亮黑（灰） | 级别徽章 |
| dim | `2` | 时间戳、字段名、`=`、`rid` |

**不使用 24-bit 真彩品牌色。** 品牌亮色 `#1B2B4A` 在深色终端对比度极低，可用的暗色
`#7C96D6` 需 24-bit 支持；24-bit 在 CI、老版本 tmux/screen、部分 Windows 终端会被降级
或产生乱码。日志跨环境高频输出，兼容性优先于品牌表现。品牌色留在 UI 与文档站
（`dev-docs/design/noj-design-tokens.md` 的辖区）。

## 2. 单行布局

```
14:32:07.412  INFO   评测任务入队  rid=550e8400  queue_length=3
└── dim ────┘  └级别色┘ └──msg──┘  └─ dim ──┘  └ key dim · = dim · value 默认色 ┘
```

- 时间戳 `HH:MM:SS.mmm`，**固定 12 字符**，dim。**不加方括号**（定宽已足够分列）。
- 级别 `padEnd(5)` 定宽（`INFO ` / `WARN ` / `ERROR` / `DEBUG`）着色；WARN/ERROR **整行额外粗体**。
- `rid` 为 `request_id` 前 8 字符，dim。
- 字段：`key` dim、`=` dim、`value` 默认色；字段间**两空格**。
- 字段**不排序**（对象字面量顺序天然稳定）。
- msg 含换行时，后续行缩进到 **msg 起始列（第 20 列，0-based 19）**：12 + 2 + 5 + 2 = 21 个空格前缀，即 `" ".repeat(21)`。
- **字段去重**：LogTape 插值后键仍在 `properties` 中，渲染字段区时必须排除已插值进
  message 的键。去重**只发生在呈现层**；`LogRecord.fields` 保留全部字段。

## 3. 着色判定顺序

```
NO_COLOR 已设且非空   → 关
LOG_COLOR=never      → 关
LOG_COLOR=always     → 开
LOG_COLOR=auto/未设   → 按流探测 TTY
```

两条硬规则：

1. **按流分别探测**。warn/error 走 stderr，info/debug 走 stdout。TS 侧用
   `Deno.stdout.isTerminal()` / `Deno.stderr.isTerminal()`；Rust 侧用 `std::io::IsTerminal`。
2. **`LOG_FORMAT=json` 时恒无色，`LOG_COLOR` 被忽略。** 此规则优先于一切开关。

`LOG_COLOR` 非法值按 `auto` 处理并 warn 一次，不致命。`NO_COLOR=""`（空串）不算设置。

## 4. 机器可读输出（JSON）

`LOG_FORMAT=json` 时输出**保持与既有形状兼容**：

```json
{"ts":"2026-09-12T05:11:45.689Z","level":"info","msg":"入队 abc","submission_id":"abc","queue_length":3}
```

- `ts` ISO 8601、`level` 小写契约名（`debug|info|warn|error`）、`msg` 渲染后文本。
- `request_id` 存在时才出现。
- 其余字段**平铺**在顶层。
- **恒无 ANSI 转义序列。**
- 已知缺陷（本期不修）：业务字段名为 `msg`/`level`/`ts` 时会覆盖保留字段。

## 5. 模块名

TS 侧由 LogTape `category` 提供，取该文件所属域或 shared 子目录名
（`submission` / `identity` / `db` / `sse` …），根文件（`main.ts`/`app.ts`）取 `core`。
Rust 侧用 tracing 的 `target`。本期**不做**列内对齐。

## 6. 脱敏不变量

生产环境（`NOJ_ENV=production`）必须脱敏，且**消息插值位置同样要脱敏**——
迁移到消息模板后敏感值会进入 message，字段区脱敏管不到它。

| 规则 | 字段 |
|---|---|
| 整值抹除 | `password` `password_hash` `token` `token_hash` `secret` `code` `email` `authorization` `cookie` `jwt` `api_key` `encrypted_api_key` `eval_token` `service_token` `store_key` |
| 截断为前 8 字符 + `...` | `submission_id` `user_id` `problem_id` `conversation_id` `message_id` 及任意 `*_id` |
| 整值隐藏 | `score` |

开发/测试环境不脱敏（便于本地调试）；Error 保留 `stack`，生产仅 `{name, message}`。
````

- [ ] **Step 2: 把文档挂进索引**

读 `dev-docs/engineering/README.md`，在文档列表中按现有格式加入一行指向 `log-conventions.md`（描述：日志视觉契约——颜色语义、单行布局、着色判定、脱敏不变量）。

- [ ] **Step 3: 校验 Markdown 链接**

```bash
deno run -A scripts/verify-md-links.ts
```

预期：退出码 0。

- [ ] **Step 4: 提交**

```bash
jj describe -m "docs(root): 新增跨运行时日志视觉契约"
jj new
```

---

### Task 2: LogTape 渲染层（formatter + 脱敏 + 级别映射）

**Files:**
- Create: `noj-core/src/shared/base/log-format.ts`
- Test: `noj-core/tests/shared/log-format.test.ts`
- Modify: `noj-core/deno.json`（`imports` 加 LogTape；`tasks` 加 `check:log-migration` 占位留到 Task 4）

**Interfaces:**
- Consumes: 无（本任务是 core 日志栈的最底层）。
- Produces: 以下导出，Task 3/4/5 依赖：
  - `SGR: { reset, dim, bold, info, debug, warn, error }`（`as const`，值为 SGR 字符串）
  - `type LogLevel = "debug" | "info" | "warn" | "error"`
  - `resolveLevel(): LogLevel`
  - `isProduction(): boolean`
  - `toLogTapeLevel(level: LogLevel): string`（`warn` → `warning`）
  - `toCoreLevel(lt: string): LogLevel`（`warning` → `warn`，`trace`/`fatal` 折叠）
  - `levelRank(level: LogLevel): number`
  - `orderedPlaceholders(raw: string | readonly string[]): string[]`
  - `redactId(id: string, visiblePrefix?: number): string`
  - `redactValueByKey(key: string, value: unknown): unknown`
  - `redactFields(fields: Record<string, unknown>): Record<string, unknown>`
  - `formatFieldValue(value: unknown): string`
  - `renderableMessage(record: LtRecord): string`
  - `renderableFields(record: LtRecord): [string, unknown][]`
  - `makePrettyFormatter(opts: { color: boolean; production?: boolean }): (record: LtRecord) => string`
  - `makeJsonFormatter(): (record: LtRecord) => string`
  - 类型别名 `LtRecord`（= LogTape 的 `LogRecord`）

- [ ] **Step 1: 加依赖**

编辑 `noj-core/deno.json` 的 `imports`，在 `"@std/encoding"` 一行后加入：

```json
    "@logtape/logtape": "jsr:@logtape/logtape@^2.3.4",
```

- [ ] **Step 2: 写失败测试**

创建 `noj-core/tests/shared/log-format.test.ts`：

```ts
import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1";
import { configureSync, getLogger, type LogRecord as LtRecord, type Sink } from "@logtape/logtape";
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
function capture(fn: (emit: (lvl: string, msg: string, props: Record<string, unknown>) => void) => void): LtRecord[] {
  const seen: LtRecord[] = [];
  const sink: Sink = (r) => { seen.push(r); };
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
  assertStrictEquals(/\x1b\[/.test(line), false, "无色模式不得含转义序列");
  // 时间戳 HH:MM:SS.mmm（12 字符）+ 2 空格 + 级别（padEnd(5)）+ 2 空格。
  // INFO 被 padEnd 成 "INFO "，再加 2 空格分隔，故 INFO 后共 3 个空格。
  assertEquals(
    /^\d{2}:\d{2}:\d{2}\.\d{3} {2}INFO {3}/.test(line),
    true,
    `布局不符: ${JSON.stringify(line)}`,
  );
  assertEquals(line.includes("入队 550e8400-e29b-41d4-a716-446655440000"), true);
  // 已插值的 submission_id 不得在字段区重复出现（去重只发生在呈现层）
  assertEquals(line.includes("submission_id="), false, "插值键不应重复渲染在字段区");
  // 未插值的 queue_length 必须出现在字段区
  assertEquals(line.includes("queue_length=3"), true);
});

Deno.test("log-format: pretty 有色输出含契约 SGR", () => {
  const records = capture((emit) => emit("error", "出错", { x: 1 }));
  const line = makePrettyFormatter({ color: true, production: false })(records[0]!)
    .trimEnd();
  assertEquals(line.includes("\x1b[1;31m"), true, "ERROR 应为粗体红");
  assertEquals(line.startsWith("\x1b[1m"), true, "WARN/ERROR 整行粗体");
  assertEquals(line.endsWith("\x1b[0m"), true);
});

Deno.test("log-format: 多行 msg 缩进到 msg 列", () => {
  const records = capture((emit) => emit("info", "第一行\n第二行", {}));
  const line = makePrettyFormatter({ color: false, production: false })(records[0]!);
  const second = line.split("\n")[1]!;
  assertEquals(second.startsWith(" ".repeat(21) + "第二行"), true, `实际: ${JSON.stringify(second)}`);
});

Deno.test("log-format: 生产环境消息插值位置也脱敏", () => {
  withEnv({ NOJ_ENV: "production" }, () => {
    const records = capture((emit) => {
      emit("info", "提交 {submission_id} 完成", {
        submission_id: "550e8400-e29b-41d4-a716-446655440000",
      });
    });
    const formatted = makeJsonFormatter()(records[0]!);
    const parsed = JSON.parse(formatted) as { msg: string; submission_id: string };
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
  const parsed = JSON.parse(makeJsonFormatter()(records[0]!)) as Record<string, unknown>;
  assertEquals(parsed.level, "warn", "JSON level 用小写契约名");
  assertEquals(parsed.msg, "警告 1");
  assertEquals(parsed.a, 1);
  assertEquals(parsed.b, 2);
  assertEquals(typeof parsed.ts, "string");
  assertEquals("properties" in parsed, false, "字段应平铺而非嵌套");
  assertStrictEquals(/\x1b\[/.test(JSON.stringify(parsed)), false);
});

Deno.test("log-format: renderableFields 排除插值键与 request_id", () => {
  const records = capture((emit) => emit("info", "取 {a}", { a: 1, b: 2, request_id: "rid" }));
  assertEquals(renderableFields(records[0]!).map(([k]) => k), ["b"]);
  // 但 message 仍能渲染出 a 与 request_id 之外的信息
  assertEquals(renderableMessage(records[0]!).includes("1"), true);
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd noj-core && bash scripts/test-shared.sh
```

预期：FAIL，报 `Module not found ... log-format.ts`。

- [ ] **Step 4: 实现 log-format.ts**

创建 `noj-core/src/shared/base/log-format.ts`。**逐字使用以下实现**——其中每个分支都对应 Global Constraints 里的一条实测行为：

```ts
/**
 * 日志渲染层：pretty / JSON formatter、脱敏、级别映射。
 *
 * 视觉契约见 `dev-docs/engineering/log-conventions.md`。
 *
 * LogTape 行为要点（均经实测，改动前请读 §Global Constraints）：
 * - `record.message` 是交错数组（长度奇数），不是字符串；
 * - 插值后的键仍保留在 `properties` 中，呈现字段区须排除以免重复；
 * - 级别字符串是 `warning` 而非 `warn`；
 * - `getTextFormatter` 的 `format` 必须是函数。
 */

import type {
  FormattedValues,
  LogRecord as LtRecord,
  TextFormatterOptions,
} from "@logtape/logtape";
import { getTextFormatter } from "@logtape/logtape";

export type { LtRecord };

/** SGR 常量（与视觉契约 §1 一一对应）。 */
export const SGR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  info: "\x1b[36m",
  debug: "\x1b[90m",
  warn: "\x1b[1;33m",
  error: "\x1b[1;31m",
} as const;

/** core 对外契约级别名。 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 生产环境判定（`NOJ_ENV=production`）。 */
export function isProduction(): boolean {
  return Deno.env.get("NOJ_ENV") === "production";
}

/**
 * 解析当前生效的日志级别。
 *
 * 优先 `LOG_LEVEL`；非法或未设置时按环境回退（生产 warn，否则 debug）。
 * 每次调用重新解析，便于测试动态切换。
 */
export function resolveLevel(): LogLevel {
  const raw = Deno.env.get("LOG_LEVEL")?.trim().toLowerCase();
  if (raw && Object.prototype.hasOwnProperty.call(LEVEL_ORDER, raw)) {
    return raw as LogLevel;
  }
  return isProduction() ? "warn" : "debug";
}

/**
 * core 级别名 → LogTape 级别名（`warn` → `warning`）。
 *
 * 实现中不直接调用：级别过滤由 `toCoreLevel` + `levelRank` 完成（把
 * LogTape 的级别映射回 core 词汇再比较）。本函数存在是为了给这层映射
 * 一个**可测的单一事实源**——配置里若误写 `lowestLevel: "warn"`，
 * LogTape 会抛 `TypeError`，而这里的单测锁住"契约名 `warn` ↔
 * LogTape 名 `warning`"的对应关系。
 */
export function toLogTapeLevel(level: LogLevel): string {
  return level === "warn" ? "warning" : level;
}

/** LogTape 级别名 → core 级别名（`warning` → `warn`，`trace`/`fatal` 折叠）。 */
export function toCoreLevel(lt: string): LogLevel {
  switch (lt) {
    case "trace":
    case "debug":
      return "debug";
    case "warning":
    case "warn":
      return "warn";
    case "error":
    case "fatal":
      return "error";
    default:
      return "info";
  }
}

/** 级别数值（供动态过滤比较）。 */
export function levelRank(level: LogLevel): number {
  return LEVEL_ORDER[level];
}

/**
 * 按**出现顺序**返回占位符名（含重复），供与交错数组中的值一一对应。
 *
 * 先移除 `{{` / `}}` 转义，避免把转义序列误当占位符。
 */
export function orderedPlaceholders(raw: string | readonly string[]): string[] {
  const text = typeof raw === "string" ? raw : raw.join("\u0000");
  const cleaned = text.replace(/\{\{/g, "").replace(/\}\}/g, "");
  return [...cleaned.matchAll(/\{([^{}]*)\}/g)]
    .map((m) => m[1]!.trim())
    .filter((k) => k.length > 0);
}

// ── 脱敏 ──────────────────────────────────────────────────────────────

/** 完全脱敏的敏感字段（值不进入日志）。 */
const SENSITIVE_KEYS = new Set([
  "password",
  "password_hash",
  "token",
  "token_hash",
  "secret",
  "code",
  "email",
  "authorization",
  "cookie",
  "jwt",
  // 网关特有（契约 §6）
  "api_key",
  "encrypted_api_key",
  "eval_token",
  "service_token",
  "store_key",
]);

/** 需要截断展示的 ID 字段。 */
const ID_KEYS = new Set([
  "submission_id",
  "user_id",
  "problem_id",
  "conversation_id",
  "message_id",
]);

/**
 * 截断 ID 用于日志展示，保留前缀可识别性但避免完整泄露。
 *
 * @example
 * redactId("550e8400-e29b-41d4-a716-446655440000") // "550e8400..."
 */
export function redactId(id: string, visiblePrefix = 8): string {
  if (!id || id.length <= visiblePrefix) return "[redacted]";
  return `${id.slice(0, visiblePrefix)}...`;
}

/** Error → 契约形状（生产去掉 stack）。 */
export function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return isProduction()
      ? { name: value.name, message: value.message }
      : { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/**
 * 按字段名对单个值套用脱敏规则。
 *
 * 迁移到消息模板后敏感值会**进入 message**，字段区脱敏管不到它；
 * 不按占位符名逐值脱敏会造成生产环境明文泄露。
 */
export function redactValueByKey(key: string, value: unknown): unknown {
  if (!isProduction()) return serializeValue(value);
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) return "[redacted]";
  if (lower === "score") return "[redacted]";
  if (ID_KEYS.has(lower) || lower.endsWith("_id")) {
    return typeof value === "string"
      ? redactId(value)
      : serializeValue(value);
  }
  return serializeValue(value);
}

/**
 * 对字段做环境相关脱敏。
 *
 * 开发/测试：仅做 Error 序列化。生产：敏感键抹除、`score` 隐藏、`*_id` 截断。
 */
export function redactFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!isProduction()) {
      out[key] = serializeValue(value);
      continue;
    }
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lower)) {
      out[key] = "[redacted]";
      continue;
    }
    if (lower === "score") continue; // 分值在生产日志中隐藏
    if (ID_KEYS.has(lower) || lower.endsWith("_id")) {
      out[key] = typeof value === "string"
        ? redactId(value)
        : serializeValue(value);
      continue;
    }
    out[key] = serializeValue(value);
  }
  return out;
}

// ── 渲染 ──────────────────────────────────────────────────────────────

/** 渲染单个字段值：字符串不加引号（与既有输出形状一致）。 */
export function formatFieldValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * 重建 message，对插值位置按占位符名逐值脱敏。
 *
 * `record.message` 是交错数组（文本/值交替），占位符名按 `rawMessage`
 * 的出现顺序解析，二者一一对应。
 */
export function renderableMessage(record: LtRecord): string {
  const parts = record.message as readonly unknown[];
  const ordered = orderedPlaceholders(
    record.rawMessage as string | readonly string[],
  );
  const out: string[] = [];
  let vi = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      out.push(String(parts[i] ?? ""));
    } else {
      out.push(formatFieldValue(redactValueByKey(ordered[vi++] ?? "", parts[i])));
    }
  }
  return out.join("");
}

/**
 * 呈现用字段列表：脱敏后剔除 `request_id` 与已插值键。
 *
 * 去重只发生在**呈现层**——`LogRecord.fields` 仍保留全部字段，
 * 否则既有测试对 `fields.submission_id` 的断言会因消息模板化而失败。
 */
export function renderableFields(record: LtRecord): [string, unknown][] {
  const skip = new Set(
    orderedPlaceholders(record.rawMessage as string | readonly string[]),
  );
  skip.add("request_id");
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record.properties)) {
    if (!skip.has(k)) kept[k] = v;
  }
  return Object.entries(redactFields(kept));
}

/** 时间戳列宽（`HH:MM:SS.mmm`）。 */
const TIME_WIDTH = 12;
/** 级别列宽（`padEnd(5)`）。 */
const LEVEL_WIDTH = 5;
/** msg 起始列：时间戳 + 2 + 级别 + 2。 */
const MSG_COLUMN = TIME_WIDTH + 2 + LEVEL_WIDTH + 2;

/** 契约 pretty 布局（视觉契约 §2）。 */
export function formatPretty(
  values: FormattedValues,
  opts: { color: boolean; production: boolean },
): string {
  const record = values.record;
  const level = toCoreLevel(record.level);
  const time = values.timestamp ?? "";
  const rid = typeof record.properties.request_id === "string"
    ? record.properties.request_id.slice(0, 8)
    : undefined;

  const parts: string[] = [];
  parts.push(opts.color ? `${SGR.dim}${time}${SGR.reset}` : time, "  ");
  const badge = level.toUpperCase().padEnd(LEVEL_WIDTH);
  parts.push(opts.color ? `${SGR[level]}${badge}${SGR.reset}` : badge, "  ");

  const indent = " ".repeat(MSG_COLUMN);
  parts.push(renderableMessage(record).split("\n").join(`\n${indent}`));

  if (rid) {
    parts.push(
      "  ",
      opts.color ? `${SGR.dim}rid=${rid}${SGR.reset}` : `rid=${rid}`,
    );
  }
  const entries = renderableFields(record);
  if (entries.length > 0) {
    parts.push(
      "  ",
      entries
        .map(([k, v]) =>
          opts.color
            ? `${SGR.dim}${k}=${SGR.reset}${formatFieldValue(v)}`
            : `${k}=${formatFieldValue(v)}`
        )
        .join("  "),
    );
  }

  const line = parts.join("");
  return opts.color && (level === "warn" || level === "error")
    ? `${SGR.bold}${line}${SGR.reset}`
    : line;
}

/**
 * 构造 pretty formatter。
 *
 * 两种着色状态都用 `getTextFormatter` + 自定义 `format`：着色完全由
 * `formatPretty` 产生，因此 `color:false` 时**保证零转义序列**，也不必
 * 与内置 ansi formatter 的 value 着色逻辑博弈（它会给插值字符串加引号
 * 并上色，与契约的"裸值"不符）。
 */
export function makePrettyFormatter(
  opts: { color: boolean; production?: boolean },
): (record: LtRecord) => string {
  const production = opts.production ?? isProduction();
  const options: TextFormatterOptions = {
    timestamp: "time",
    value: (v: unknown) => formatFieldValue(v),
    format: (values: FormattedValues) =>
      formatPretty(values, { color: opts.color, production }),
  };
  return getTextFormatter(options);
}

/**
 * 构造 **core 既有形状**的 JSON formatter。
 *
 * 不使用 `getJsonLinesFormatter()`——它的形状（`@timestamp` / 大写级别 /
 * `properties` 嵌套）与既有契约不兼容。
 */
export function makeJsonFormatter(): (record: LtRecord) => string {
  return (record: LtRecord): string => {
    const fields = redactFields(record.properties);
    const rid = fields.request_id;
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === "request_id") continue;
      rest[k] = v instanceof Error ? serializeValue(v) : v;
    }
    return JSON.stringify({
      ts: new Date(record.timestamp).toISOString(),
      level: toCoreLevel(record.level),
      msg: renderableMessage(record),
      ...(rid === undefined ? {} : { request_id: rid }),
      ...rest,
    });
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd noj-core && bash scripts/test-shared.sh
```

预期：全部 PASS（含既有 8 个 logging 测试，此刻它们尚未受影响）。

- [ ] **Step 6: 格式化与静态检查**

```bash
cd noj-core && deno fmt && deno lint
```

- [ ] **Step 7: 提交**

```bash
jj describe -m "feat(core): 新增 LogTape 渲染层（契约布局、脱敏、级别映射）"
jj new
```

---

### Task 3: 兼容层与 LogTape 装配（核心）

**Files:**
- Create: `noj-core/src/shared/base/log-config.ts`
- Modify: `noj-core/src/shared/base/logging.ts`（整体替换为兼容层）
- Modify: `noj-core/tests/shared/logging_test.ts:1-30`（仅改 import 路径外的行为无关部分；见下）

**Interfaces:**
- Consumes: Task 2 的全部导出。
- Produces:
  - `log-config.ts`:
    - `resolveColor(stream: "stdout" | "stderr"): boolean`
    - `describeColorPolicy(): "off" | "on" | "auto"`
    - `resolveFormat(): "json" | "pretty"`
    - `setupLogging(sink?: LogSink): void`（幂等；内部 `configureSync({reset: true, ...})`。
      `sink` 省略 = 走 console 输出；传入 = 记录交给该 sink）
  - `logging.ts`（导出保持不变，语义不变）：
    - `type LogLevel`、`interface LogRecord`、`type LogSink`
    - `redactId(id, visiblePrefix?)`、`isProduction()`
    - `setLogSink(sink)`、`resetLogSink()`
    - `logger: { debug, info, warn, error }`（签名 `(msg: string, fields?: Record<string, unknown>) => void`）
    - `logJudgeTaskEnqueued(submissionId, queueLength, messageBytes): void`
    - `logJudgeResultReceived(submissionId, status, score): void`
  - **不导出**：`defaultSink`（维持现状）。**不导出** LogTape 类型（防止业务代码耦合底层库）。

- [ ] **Step 1: 写失败测试**

创建 `noj-core/tests/shared/log-config.test.ts`：

```ts
import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1";
import {
  describeColorPolicy,
  resolveColor,
  resolveFormat,
} from "./../../src/shared/base/log-config.ts";

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
  withEnv({ LOG_COLOR: "always", NO_COLOR: undefined, LOG_FORMAT: undefined }, () => {
    assertEquals(resolveColor("stdout"), true);
    assertEquals(resolveColor("stderr"), true);
  });
});

Deno.test("log-config: LOG_COLOR=never 强制关色", () => {
  withEnv({ LOG_COLOR: "never", NO_COLOR: undefined, LOG_FORMAT: undefined }, () => {
    assertEquals(resolveColor("stdout"), false);
    assertEquals(resolveColor("stderr"), false);
  });
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
  withEnv({ LOG_FORMAT: "json", LOG_COLOR: "always", NO_COLOR: undefined }, () => {
    assertEquals(resolveColor("stdout"), false);
    assertEquals(resolveColor("stderr"), false);
  });
});

Deno.test("log-config: 非法 LOG_COLOR 按 auto 处理", () => {
  withEnv({ LOG_COLOR: "bogus", NO_COLOR: undefined, LOG_FORMAT: undefined }, () => {
    assertEquals(describeColorPolicy(), "auto");
  });
});

Deno.test("log-config: resolveFormat 按环境回退", () => {
  withEnv({ LOG_FORMAT: "json" }, () => assertEquals(resolveFormat(), "json"));
  withEnv({ LOG_FORMAT: "pretty" }, () => assertEquals(resolveFormat(), "pretty"));
  withEnv({ LOG_FORMAT: undefined, NOJ_ENV: "production" }, () =>
    assertEquals(resolveFormat(), "json"));
  withEnv({ LOG_FORMAT: undefined, NOJ_ENV: "development" }, () =>
    assertEquals(resolveFormat(), "pretty"));
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd noj-core && bash scripts/test-shared.sh
```

预期：FAIL，`Module not found ... log-config.ts`。

- [ ] **Step 3: 实现 log-config.ts**

创建 `noj-core/src/shared/base/log-config.ts`：

```ts
/**
 * LogTape 装配与着色策略。
 *
 * 着色判定顺序（视觉契约 §3）：
 *   NO_COLOR 非空 → 关；LOG_COLOR=never → 关；LOG_COLOR=always → 开；
 *   其余按流探测 TTY。LOG_FORMAT=json 时恒无色且忽略 LOG_COLOR。
 */

import {
  configureSync,
  getConsoleSink,
  getLogger,
} from "@logtape/logtape";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  isProduction,
  levelRank,
  makeJsonFormatter,
  makePrettyFormatter,
  resolveLevel,
  toCoreLevel,
} from "./log-format.ts";
import type { LogRecord as LtRecord } from "@logtape/logtape";
import type { LogRecord, LogSink } from "./logging.ts";

/** 着色策略的有效值。 */
export type ColorPolicy = "off" | "on" | "auto";

/** 解析 LOG_COLOR，非法值按 auto 处理。 */
export function describeColorPolicy(): ColorPolicy {
  const raw = Deno.env.get("LOG_COLOR")?.trim().toLowerCase();
  if (raw === "never") return "off";
  if (raw === "always") return "on";
  return "auto";
}

/** 解析输出格式（生产 json，否则 pretty）。 */
export function resolveFormat(): "json" | "pretty" {
  const raw = Deno.env.get("LOG_FORMAT")?.trim().toLowerCase();
  if (raw === "json" || raw === "pretty") return raw;
  return isProduction() ? "json" : "pretty";
}

/** 按流探测 TTY。 */
function isTty(stream: "stdout" | "stderr"): boolean {
  try {
    return stream === "stderr"
      ? Deno.stderr.isTerminal()
      : Deno.stdout.isTerminal();
  } catch {
    return false; // 无 TTY 支持的环境（部分嵌入运行时）保守关色
  }
}

/**
 * 判定某个流是否着色（视觉契约 §3）。
 *
 * `LOG_FORMAT=json` 优先于一切开关，专门防止 ANSI 转义码写进结构化日志流。
 */
export function resolveColor(stream: "stdout" | "stderr"): boolean {
  if (resolveFormat() === "json") return false;
  const noColor = Deno.env.get("NO_COLOR");
  if (noColor !== undefined && noColor !== "") return false;
  switch (describeColorPolicy()) {
    case "off":
      return false;
    case "on":
      return true;
    default:
      return isTty(stream);
  }
}

/** 供 LogTape 读取 request_id 的存储（复用既有 observability kernel 的语义）。 */
export const logContextStorage = new AsyncLocalStorage<Record<string, unknown>>();

/** 动态级别过滤：每条记录都重新解析 LOG_LEVEL，便于测试中途切换。 */
function dynamicLevelFilter(record: LtRecord): boolean {
  return levelRank(toCoreLevel(record.level)) >= levelRank(resolveLevel());
}

/** LogTape 记录 → core 兼容记录。渲染层只负责字符串，这里负责对象形状。 */
function toCompatRecord(record: LtRecord): LogRecord {
  const { renderableMessage } = compatRenderers;
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record.properties)) {
    if (k === "request_id") continue;
    fields[k] = v;
  }
  return {
    ts: new Date(record.timestamp).toISOString(),
    level: toCoreLevel(record.level),
    msg: renderableMessage(record),
    request_id: typeof record.properties.request_id === "string"
      ? record.properties.request_id
      : undefined,
    fields: compatRenderers.redactFields(fields),
  };
}

/**
 * 为避免与 logging.ts 形成循环依赖，渲染函数由 logging.ts 在装配时注入。
 * （logging.ts 依赖 log-config.ts 的类型与装配，log-config.ts 依赖
 *  logging.ts 的渲染函数——用注入打破循环。）
 */
export const compatRenderers: {
  redactFields: (f: Record<string, unknown>) => Record<string, unknown>;
  renderableMessage: (r: LtRecord) => string;
} = {
  redactFields: (f) => f,
  renderableMessage: () => "",
};

/** 注册渲染函数（由 logging.ts 模块初始化时调用一次）。 */
export function registerCompatRenderers(r: typeof compatRenderers): void {
  compatRenderers.redactFields = r.redactFields;
  compatRenderers.renderableMessage = r.renderableMessage;
}

/**
 * 装配 LogTape。
 *
 * @param sink 兼容层 sink；为 `null` 时丢弃记录（测试的 resetLogSink 语义），
 *             为 `undefined` 时走真实 console 输出。
 */
export function setupLogging(sink?: LogSink): void {
  const format = resolveFormat();
  const makeFormatter = (stream: "stdout" | "stderr") => {
    const color = resolveColor(stream);
    return format === "json"
      ? makeJsonFormatter()
      : makePrettyFormatter({ color, production: isProduction() });
  };
  const outFormatter = makeFormatter("stdout");
  const errFormatter = makeFormatter("stderr");

  // 一条记录按级别选择 formatter：console sink 自身负责把 warn/error 送到
  // stderr、其余送到 stdout（契约 §3 硬规则 1），因此这里只需按目标流
  // 决定是否着色。
  //
  // 用 getConsoleSink 而非 getStreamSink：后者带异步 disposer，configureSync
  // 会直接抛 ConfigError；且 getConsoleSink 同步写出，Deno.exit 下不丢日志。
  const consoleSink = getConsoleSink({
    formatter: (record: LtRecord) => {
      const level = toCoreLevel(record.level);
      const isErr = level === "warn" || level === "error";
      return (isErr ? errFormatter : outFormatter)(record);
    },
  });

  const target = sink === undefined
    ? consoleSink
    : (record: LtRecord) => sink(toCompatRecord(record));

  configureSync({
    reset: true,
    sinks: { target },
    filters: { level: dynamicLevelFilter },
    contextLocalStorage: logContextStorage,
    loggers: [
      { category: [], sinks: ["target"], filters: ["level"], lowestLevel: "trace" },
      // meta logger 单独可见：LogTape 自身的失败（如 formatter 抛错）
      // 只记在这里，不配就完全静默（实测的静默失败面）。
      { category: ["logtape", "meta"], sinks: ["target"], lowestLevel: "warning" },
    ],
  });
}
```

同时把该文件顶部的 import 改为（**不要**引入 `getLevelFilter` 或 `getStreamSink`）：

```ts
import {
  configureSync,
  getConsoleSink,
  getLogger,
} from "@logtape/logtape";
```

并删除 `compatRenderers` 上方的 `toCompatRecord` 里对 `compatRenderers` 的解构方式保持不变（该函数已用到它）。

- [ ] **Step 4: 重写 logging.ts 为兼容层**

把 `noj-core/src/shared/base/logging.ts` 整体替换为：

```ts
/**
 * 结构化日志（兼容层）。
 *
 * 外观与导出**保持不变**，内部已迁移到 LogTape 2.3.4：
 * - 级别控制：`LOG_LEVEL`（默认生产 warn、开发 debug）
 * - 输出格式：`LOG_FORMAT`（默认生产 json、开发 pretty）
 * - 着色：`NO_COLOR` / `LOG_COLOR` / TTY（见 `log-config.ts`）
 * - 内置脱敏：生产环境截断 `*_id`、隐藏 `score`、抹除 `code`/`token`/`secret` 等
 * - 自动附带 `request_id`（复用 `shared/observability/context.ts` 的 ALS）
 * - 可注入 sink，便于测试捕获输出
 *
 * 渲染与脱敏规则实现在 `log-format.ts`；装配在 `log-config.ts`。
 */

import { getLogger } from "@logtape/logtape";
import {
  getRequestId,
  runWithRequestContext,
} from "../observability/context.ts";
import {
  logContextStorage,
  registerCompatRenderers,
  setupLogging,
} from "./log-config.ts";
import {
  redactFields,
  renderableMessage,
  type LogLevel,
} from "./log-format.ts";

export type { LogLevel };
export { isProduction, redactId } from "./log-format.ts";

// 打破与 log-config.ts 的循环依赖：把渲染函数注入装配层
registerCompatRenderers({ redactFields, renderableMessage });

/** 结构化日志记录。 */
export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  request_id?: string;
  fields: Record<string, unknown>;
}

/** 日志输出目的地。默认写 console；测试可替换以捕获记录。 */
export type LogSink = (record: LogRecord) => void;

let currentSink: LogSink | undefined;

/** 替换日志 sink（测试用，用于捕获日志记录）。 */
export function setLogSink(sink: LogSink): void {
  currentSink = sink;
  setupLogging(sink);
}

/** 恢复默认 sink（测试清理用）。 */
export function resetLogSink(): void {
  currentSink = undefined;
  setupLogging();
}

// 模块初始化即装配一次默认输出
setupLogging();

/**
 * 在 `request_id` 上下文中执行 `fn`。
 *
 * 与 `shared/observability/context.ts` 的 `runWithRequestContext` 是同一份
 * ALS 语义；这里复用其存储，使 LogTape 的 `contextLocalStorage` 能读到值。
 */
export function runWithLogContext<T>(requestId: string, fn: () => T): T {
  return logContextStorage.run({ request_id: requestId }, fn);
}

/** 读取当前 request_id（供内部装配自检）。 */
export function currentRequestId(): string | undefined {
  return getRequestId();
}

// ── 核心 emit + logger ────────────────────────────────────────────────

function emit(
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  // 级别过滤由 LogTape 的 dynamicLevelFilter 统一负责，此处直接投递
  const log = getLogger(["noj", "legacy"]);
  const props: Record<string, unknown> = { ...(fields ?? {}) };
  const rid = getRequestId();
  if (rid !== undefined) props.request_id = rid;
  switch (level) {
    case "debug":
      log.debug(msg, props);
      break;
    case "info":
      log.info(msg, props);
      break;
    case "warn":
      log.warn(msg, props);
      break;
    case "error":
      log.error(msg, props);
      break;
  }
}

/**
 * 结构化 logger。
 *
 * @example
 * logger.info("评测任务入队", { submission_id, queue_length });
 * logger.error("推送失败", { err, submission_id });
 */
export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) =>
    emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) =>
    emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) =>
    emit("error", msg, fields),
};

// ── 向后兼容的具名日志函数 ────────────────────────────────────────────

/**
 * 输出评测任务入队日志。
 * 脱敏由渲染层统一处理（生产环境截断 submission_id）。
 */
export function logJudgeTaskEnqueued(
  submissionId: string,
  queueLength: number,
  messageBytes: number,
): void {
  logger.info("评测任务入队", {
    submission_id: submissionId,
    queue_length: queueLength,
    size_bytes: messageBytes,
  });
}

/**
 * 输出评测结果接收日志。
 * 脱敏由渲染层统一处理（生产环境截断 submission_id、隐藏 score）。
 */
export function logJudgeResultReceived(
  submissionId: string,
  status: string,
  score: number,
): void {
  logger.info("收到评测结果", {
    submission_id: submissionId,
    status,
    score,
  });
}
```

- [ ] **Step 5: 让既有 8 个测试通过（零改动）**

```bash
cd noj-core && bash scripts/test-shared.sh
```

预期：`tests/shared/logging_test.ts` 的 8 个测试**全部 PASS 且文件未被修改**。

若失败，**先判断是哪一类**，不要直接改测试：
- `records.length` 不符 → `dynamicLevelFilter` 或 `LOG_LEVEL` 重解析有问题；
- `fields.submission_id` 未截断 → `compatRenderers.redactFields` 未生效（注册顺序）；
- `request_id` 为 `undefined` → `logContextStorage` 未收到 `runWithRequestContext` 写入的上下文。

- [ ] **Step 6: 确认 request_id 跨 await 传播**

在 `noj-core/tests/shared/log-config.test.ts` 末尾追加：

```ts
import { logger, resetLogSink, setLogSink } from "./../../src/shared/base/logging.ts";
import { runWithRequestContext } from "./../../src/shared/observability/context.ts";

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
```

运行：

```bash
cd noj-core && bash scripts/test-shared.sh
```

预期：PASS。

- [ ] **Step 7: 格式化与静态检查**

```bash
cd noj-core && deno fmt && deno lint && deno task check:types
```

- [ ] **Step 8: 提交**

```bash
jj describe -m "feat(core): 日志改为 LogTape 装配，兼容层保持既有导出与断言形状"
jj new
```

---

### Task 4: 迁移完整性静态校验脚本

**Files:**
- Create: `scripts/check-log-migration.ts`
- Create: `scripts/check-log-migration_test.ts`
- Modify: `scripts/check-ci.ts`（加入门禁调用）
- Modify: `noj-core/deno.json` 或根 `scripts`（不新增 task；由 `check-ci.ts` 调用）

**Interfaces:**
- Consumes: 无（独立 AST 工具）。
- Produces:
  - `export interface LogCallSite { file: string; line: number; level: string; msgText: string; kind: "template" | "string" | "other"; placeholders: string[]; propertyKeys: string[] | null; }`
  - `export function scanSource(text: string, file: string): LogCallSite[]`
  - `export function findViolations(sites: LogCallSite[]): { file: string; line: number; message: string }[]`
  - CLI：无违规退出 0；有违规打印清单退出 1。

- [ ] **Step 1: 写失败测试**

创建 `scripts/check-log-migration_test.ts`：

```ts
import { assertEquals } from "jsr:@std/assert@^1";
import { findViolations, scanSource } from "./check-log-migration.ts";

Deno.test("scanSource: 识别 logger.* 调用与级别", () => {
  const sites = scanSource(
    `logger.info("普通消息", { a: 1 });\nlogger.warn(\`\${label}启动\`);`,
    "t.ts",
  );
  assertEquals(sites.length, 2);
  assertEquals(sites[0]!.level, "info");
  assertEquals(sites[0]!.kind, "string");
  assertEquals(sites[1]!.level, "warn");
  assertEquals(sites[1]!.kind, "template");
});

Deno.test("findViolations: 残留 JS 模板插值被拒绝", () => {
  const sites = scanSource("logger.info(`${label}启动`);", "t.ts");
  const v = findViolations(sites);
  assertEquals(v.length, 1);
  assertEquals(v[0]!.message.includes("模板字符串"), true, v[0]!.message);
});

Deno.test("findViolations: 占位符无对应属性被拒绝", () => {
  const sites = scanSource(`logger.info("入队 {sid}", { other: 1 });`, "t.ts");
  const v = findViolations(sites);
  assertEquals(v.length, 1);
  assertEquals(v[0]!.message.includes("sid"), true, v[0]!.message);
});

Deno.test("findViolations: 占位符与属性匹配则通过", () => {
  const sites = scanSource(`logger.info("入队 {sid}", { sid });`, "t.ts");
  assertEquals(findViolations(sites).length, 0);
});

Deno.test("findViolations: 字面花括号未转义被拒绝", () => {
  const sites = scanSource(`logger.info("集合 {a, b} 非法", {});`, "t.ts");
  // {a, b} 会被 LogTape 当占位符消费；属性里没有 a / b
  assertEquals(findViolations(sites).length >= 1, true);
});

Deno.test("findViolations: {{ }} 转义合法", () => {
  const sites = scanSource(`logger.info("集合 {{a, b}} 非法");`, "t.ts");
  assertEquals(findViolations(sites).length, 0);
});

Deno.test("findViolations: getLogger 数组形式的调用点也被扫描", () => {
  const sites = scanSource(
    `const log = getLogger(["noj","x"]);\nlog.info("m {a}", { a: 1 });`,
    "t.ts",
  );
  assertEquals(sites.length, 1);
  assertEquals(findViolations(sites).length, 0);
});

Deno.test("scanSource: 跨多行调用能取到属性键", () => {
  const sites = scanSource(
    `logger.error(\n  "失败 {a}",\n  {\n    a: 1,\n    b: 2,\n  },\n);`,
    "t.ts",
  );
  assertEquals(sites.length, 1);
  assertEquals(sites[0]!.propertyKeys, ["a", "b"]);
  assertEquals(findViolations(sites).length, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
deno test -A scripts/check-log-migration_test.ts
```

预期：FAIL，`Module not found ... check-log-migration.ts`。

- [ ] **Step 3: 实现校验脚本**

创建 `scripts/check-log-migration.ts`：

```ts
/**
 * 日志迁移完整性静态校验。
 *
 * 背景：LogTape 的消息模板把 `{...}` 解析为占位符，且**失败是静默的**——
 * 实测 `log.info("集合 {a, b} 非法?", {})` 输出 `集合 null 非法?`，不报错。
 * 同理，残留的 JS 模板字符串（`` `${label}启动` ``）会把 `${` 当作 `$` +
 * 占位符消费。这类问题不会让任何测试变红，只能靠静态检查拦住。
 *
 * 校验规则（针对 `logger.*` 与 `getLogger(...)` 得到的 logger 调用）：
 * 1. message 不得是含插值的模板字符串（应改写为 `{key}` + 属性）；
 * 2. message 中的每个 `{key}` 占位符必须在同一调用的属性对象中有对应键；
 * 3. `{{` / `}}` 视为合法转义，不参与占位符解析。
 *
 * 用法：
 *   deno run -A scripts/check-log-migration.ts
 */

import ts from "npm:typescript@5.9.2";

/** 一个待校验的日志调用点。 */
export interface LogCallSite {
  file: string;
  /** 1-based 行号 */
  line: number;
  level: string;
  msgText: string;
  kind: "template" | "string" | "other";
  placeholders: string[];
  /** 属性对象的静态键；无法静态解析时为 null */
  propertyKeys: string[] | null;
}

const LEVELS = new Set(["debug", "info", "warn", "error", "trace", "fatal"]);
const LEVEL_METHODS = new Set(["debug", "info", "warn", "error"]);

/** 从模板原文解析占位符（`{{` 转义不参与）。 */
export function parsePlaceholders(text: string): string[] {
  const cleaned = text.replace(/\{\{/g, "").replace(/\}\}/g, "");
  return [...cleaned.matchAll(/\{([^{}]*)\}/g)]
    .map((m) => m[1]!.trim())
    .filter((k) => k.length > 0);
}

/** 扫描一段源码中的日志调用点。 */
export function scanSource(text: string, file: string): LogCallSite[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const sites: LogCallSite[] = [];

  /** 收集本文件中被当作 logger 使用的标识符（如 `const log = getLogger([...])`）。 */
  const loggerAliases = new Set<string>(["logger"]);
  const collectAliases = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
      ts.isCallExpression(n.initializer) &&
      ts.isIdentifier(n.initializer.expression) &&
      n.initializer.expression.text === "getLogger"
    ) {
      loggerAliases.add(n.name.text);
    }
    ts.forEachChild(n, collectAliases);
  };
  collectAliases(sf);

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      LEVEL_METHODS.has(node.expression.name.text)
    ) {
      const receiver = node.expression.expression;
      const receiverName = ts.isIdentifier(receiver) ? receiver.text : receiver.getText(sf);
      if (loggerAliases.has(receiverName)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const msgArg = node.arguments[0];
        let kind: LogCallSite["kind"] = "other";
        let msgText = "";
        let placeholders: string[] = [];
        if (msgArg) {
          if (ts.isTemplateExpression(msgArg)) {
            kind = "template";
            msgText = msgArg.getText(sf);
          } else if (ts.isNoSubstitutionTemplateLiteral(msgArg)) {
            kind = "string";
            msgText = msgArg.text;
            placeholders = parsePlaceholders(msgText);
          } else if (ts.isStringLiteral(msgArg)) {
            kind = "string";
            msgText = msgArg.text;
            placeholders = parsePlaceholders(msgText);
          } else if (ts.isBinaryExpression(msgArg)) {
            // 字符串拼接：可能含模板插值
            const raw = msgArg.getText(sf);
            kind = raw.includes("${") ? "template" : "other";
            msgText = raw;
          } else {
            kind = "other";
            msgText = msgArg.getText(sf);
          }
        }
        // 属性对象键
        let propertyKeys: string[] | null = null;
        const propsArg = node.arguments[1];
        if (propsArg && ts.isObjectLiteralExpression(propsArg)) {
          propertyKeys = [];
          for (const p of propsArg.properties) {
            if (ts.isShorthandPropertyAssignment(p)) propertyKeys.push(p.name.text);
            else if (ts.isPropertyAssignment(p)) {
              const nm = p.name;
              if (ts.isIdentifier(nm) || ts.isStringLiteral(nm)) propertyKeys.push(nm.text);
            }
          }
        }
        sites.push({
          file,
          line,
          level: node.expression.name.text,
          msgText,
          kind,
          placeholders,
          propertyKeys,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

/** 判定违规。 */
export function findViolations(
  sites: LogCallSite[],
): { file: string; line: number; message: string }[] {
  const out: { file: string; line: number; message: string }[] = [];
  for (const s of sites) {
    if (s.kind === "template") {
      out.push({
        file: s.file,
        line: s.line,
        message:
          `message 是 JS 模板字符串（含 \${}），LogTape 会把 \${ 当作占位符静默消费。` +
          `请改写为 "{key} 文本" + 属性对象。实际: ${s.msgText.slice(0, 80)}`,
      });
      continue;
    }
    if (s.kind === "string" && s.placeholders.length > 0) {
      if (s.propertyKeys === null) continue; // 属性非字面量对象，无法静态判定
      const missing = s.placeholders.filter((p) => !s.propertyKeys!.includes(p));
      if (missing.length > 0) {
        out.push({
          file: s.file,
          line: s.line,
          message:
            `占位符 ${missing.map((m) => `{${m}}`).join(", ")} 在属性对象中无对应键，` +
            `渲染结果为 null。属性键: [${s.propertyKeys.join(", ")}]`,
        });
      }
    }
  }
  return out;
}

/** 递归收集 .ts 文件（跳过 node_modules 与构建产物）。 */
async function collect(dir: string, out: string[] = []): Promise<string[]> {
  for await (const e of Deno.readDir(dir)) {
    const full = `${dir}/${e.name}`;
    if (e.isDirectory) {
      if (["node_modules", ".git", ".output", ".deno", "dist", "coverage", "drizzle"].includes(e.name)) continue;
      await collect(full, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith("_test.ts")) {
      out.push(full);
    }
  }
  return out;
}

if (import.meta.main) {
  const roots = ["noj-core/src", "noj-llm-gateway/src"];
  const all: LogCallSite[] = [];
  for (const root of roots) {
    let files: string[] = [];
    try {
      files = await collect(root);
    } catch {
      continue; // 目录不存在（可选模块）时跳过
    }
    for (const f of files) {
      all.push(...scanSource(await Deno.readTextFile(f), f));
    }
  }
  const violations = findViolations(all);
  if (violations.length === 0) {
    console.log(
      `[check-log-migration] 通过：扫描 ${all.length} 个日志调用点，无模板语法问题`,
    );
    Deno.exit(0);
  }
  console.error(`[check-log-migration] 发现 ${violations.length} 个问题：\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`      ${v.message}\n`);
  }
  Deno.exit(1);
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
deno test -A scripts/check-log-migration_test.ts
```

预期：全部 PASS。

- [ ] **Step 5: 对当前代码库跑一次，记录基线**

```bash
deno run -A scripts/check-log-migration.ts
```

预期：**失败**，报告 22 处模板字符串（Task 5 的输入清单）。把这个数字与文件分布记下来，作为 Task 5 的验收基准。

- [ ] **Step 6: 接入 CI 门禁**

编辑 `scripts/check-ci.ts`，在 `await run(["deno", "run", "-A", "scripts/check-domains.ts"]);` 一行之前插入：

```ts
  // 日志模板语法完整性：LogTape 的占位符失败是静默的，只能静态拦
  await run(["deno", "run", "-A", "scripts/check-log-migration.ts"]);
```

同时在文件末尾的测试列表中加入本脚本的单测（若该列表存在）：

```ts
    "scripts/check-log-migration_test.ts",
```

- [ ] **Step 7: 提交**

> **注意**：此刻 `check-ci.ts` 会因 Task 5 尚未完成而失败（22 处模板）。**先只提交脚本本体与单测，把 CI 接线留到 Task 5 末尾一并提交**，避免留下红灯提交。

```bash
jj describe -m "test(root): 新增日志模板语法静态校验（AST，含单测）"
jj new
```

---

### Task 5: noj-core 调用点迁移（48 文件 / 177 处）

> 这是全计划**工作量最大**的一步。177 处中 86 处跨多行，正则无法安全重写。按域分批，每批独立可验收。

**Files:**
- Modify: `noj-core/src/**`（48 个文件，177 处调用点）
- Modify: `noj-core/src/shared/config/settings-registry.ts`（登记 `LOG_COLOR`）
- Modify: `noj-core/.env.example`（同步 `LOG_COLOR`）
- Modify: `scripts/check-ci.ts`（Task 4 Step 6 的内容，本任务末尾提交）

**Interfaces:**
- Consumes: Task 3 的 `logger`（签名不变）、Task 4 的校验脚本。
- Produces: 每个文件顶部新增一行 `import { getLogger } from "@logtape/logtape";` 与一行 `const logger = getLogger(["noj", "<category>"]);`。

**类别映射表（category 取值）**

按文件路径推导，**照此表执行，不要临场改名**：

| 路径前缀 | category |
|---|---|
| `src/main.ts`、`src/app.ts` | `core` |
| `src/domains/<domain>/...` | `<domain>`（如 `submission`、`identity`、`catalog`、`system`、`contest`、`community`、`messaging`、`admin`、`search`、`query`、`gateway`、`content-review`、`observability`） |
| `src/shared/mq/...` | `mq` |
| `src/shared/sse/...` | `sse` |
| `src/shared/db/...` | `db` |
| `src/shared/base/...` | `base` |
| 其余 `src/shared/<x>/...` | `<x>` |

**迁移改写规则**

1. 文件若无 `getLogger` 导入，在 import 区末尾加：
   ```ts
   import { getLogger } from "@logtape/logtape";
   const logger = getLogger(["noj", "<category>"]);
   ```
2. **删除**原有的 `import { logger } from ".../shared/base/logging.ts"`。若同文件还导入了 `redactId` 等其他符号，**保留那一部分**。
3. 模板字符串 message 改写（**必须**，共 22 处）：
   ```ts
   // 前
   logger.info(`${label}消费者正在启动...`);
   // 后
   logger.info("{label}消费者正在启动...", { label });
   ```
   若原本还有属性对象，**合并**而非新增第二个参数：
   ```ts
   // 前
   logger.warn(`${label}消费者将重启`, { delayMs });
   // 后
   logger.warn("{label}消费者将重启", { label, delayMs });
   ```
4. 纯字符串 message **不强制**改模板，但仍需保证 message 里的字面 `{`/`}` 已转义为 `{{`/`}}`（现状为 0 处，属预防）。
5. 字段对象中出现 `err: someError` 时保持原样（渲染层已处理 Error）。

**逐批 category 对应文件清单**

| 批次 | category | 文件数 | 调用点 | 关键文件 |
|---|---|---|---|---|
| 5a | `shared` 层 | 13 | 51 | `shared/sse/event-bus.ts`(11)、`shared/mq/connection.ts`(11)、`shared/mq/base-consumer.ts`(11)、`shared/db/connection.ts`(3)、`shared/db/migrate.ts`(3)、`shared/sse/sse-events.ts`(3)、`shared/search-events.ts`(2)、`shared/base/sql-rows.ts`(1)、`shared/base/logging.ts`(2 处具名函数) |
| 5b | `submission` | 9 | 48 | `mq/sweeper.ts`(16)、`mq/consumer.ts`(6)、`services/submissions/submissions-result.ts`(6)、`mq/legacy-judge-queue.ts`(5)、`services/self-tests.ts`(5) |
| 5c | `system` + `content-review` | 12 | 26 | `system/services/audit-log.ts`(8)、`content-review/mq/review-consumer.ts`(4) |
| 5d | `catalog` + `identity` + `contest` | 8 | 17 | `catalog/services/problems/problems-crud.ts`(4)、`contest/services/contest-anti-cheat.ts`(4) |
| 5e | `core` + 其余域 | 6 | 35 | `main.ts`(16)、`app.ts`(1)、`admin`(2)、`messaging`(2)、`query`(1)、`search`(3) |

> 表中数字为实测值；若实施时发现偏差，**以 `deno run -A scripts/check-log-migration.ts` 与 `rg -c` 的实际输出为准**，并回头修正本表。

**以下步骤对 5a–5e 每一批重复执行。**

- [ ] **Step 1: 确认本批文件与调用点**

```bash
cd noj-core/src && rg -c 'logger\.(debug|info|warn|error)\(' --glob '*.ts' <本批路径>
```

记录总数，作为迁移前后比对基准。

- [ ] **Step 2: 逐文件改写**

用 `read` 工具打开每个文件，按"迁移改写规则"改写。**不要用 sed/正则批量替换**——86 处跨多行会让锚点错位。

- [ ] **Step 3: 确认本批无遗留旧导入**

```bash
cd noj-core/src && rg -n 'from ".*shared/base/logging' <本批路径>
```

预期：无输出（说明旧 `logger` 导入已全部替换）。若文件确实还需要 `redactId` 等，则只应保留具名导入。

- [ ] **Step 4: 类型检查本批**

```bash
cd noj-core && deno check <本批文件列表>
```

预期：无错误。

- [ ] **Step 5: 跑本批对应测试**

按域运行（例如 5b 批次）：

```bash
cd noj-core && deno task test:domain submission
```

`shared` 层批次用：

```bash
cd noj-core && bash scripts/test-shared.sh
```

预期：全部 PASS。既有日志断言（`passwordReset.test.ts` / `auth.test.ts` / `submissions.test.ts`）必须仍然通过——它们断言 `record.msg` 与 `record.fields`，由兼容层保证形状。

- [ ] **Step 6: 检查模板语法**

```bash
deno run -A scripts/check-log-migration.ts
```

预期：违规数量随批次推进单调下降，最终为 0。

- [ ] **Step 7: 提交本批**

```bash
jj describe -m "refactor(core): <本批域> 日志迁移到 LogTape 消息模板"
jj new
```

- [ ] **Step 8（仅 5e 之后）: 登记 LOG_COLOR 并接线 CI**

编辑 `noj-core/src/shared/config/settings-registry.ts`，在 `LOG_FORMAT` 条目之后加入：

```ts
  {
    key: "LOG_COLOR",
    type: "string",
    description:
      "日志着色策略（auto/always/never；NO_COLOR 优先，LOG_FORMAT=json 时恒无色）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "LOG_COLOR",
    category: "other",
  },
```

编辑 `noj-core/.env.example`，在 `# LOG_FORMAT=pretty` 之后加入：

```
# 日志着色：auto（默认，按 TTY）/ always / never。
# NO_COLOR 非空时优先关闭；LOG_FORMAT=json 时恒不输出转义序列。
# LOG_COLOR=auto
```

把 Task 4 Step 6 的 `scripts/check-ci.ts` 改动一并落地。

- [ ] **Step 9（仅 5e 之后）: 校验配置登记**

```bash
cd noj-core && deno task check:env && deno task check:config-usage
```

预期：两条均通过。（`check:config-usage` 是"键名字面量出现在消费文件中"判定，`LOG_COLOR` 在 `log-config.ts` 中被读取，满足。）

- [ ] **Step 10（仅 5e 之后）: 全量验证**

```bash
cd noj-core && deno fmt && deno lint && deno task test
```

```bash
deno run -A scripts/check-log-migration.ts
deno run -A scripts/check-ci.ts
```

预期：全部通过；`check-log-migration` 报"通过：扫描 N 个日志调用点"。

- [ ] **Step 11（仅 5e 之后）: 手工回归着色策略**

```bash
cd noj-core && deno task dev > /tmp/o.txt 2>&1 &
sleep 3 && kill %1
```

逐条实测（**不要靠推断**）：

| 命令 | 期望 |
|---|---|
| `deno task dev` | 终端有色 |
| `deno task dev > /tmp/o.txt 2>&1` | `/tmp/o.txt` **无** `\x1b[` |
| `NO_COLOR=1 deno task dev` | 无色 |
| `LOG_COLOR=always deno task dev > /tmp/f` | 有色 |
| `LOG_FORMAT=json deno task dev` | 无转义，`{"ts":...}` 形状 |
| `LOG_COLOR=bogus deno task dev` | 按 auto；不崩溃 |

用 `grep -c $'\x1b\[' /tmp/o.txt` 验证转义码数量为 0。

---

### Task 6: noj-judge 契约化输出与分流

**Files:**
- Create: `noj-judge/src/logging.rs`
- Modify: `noj-judge/src/lib.rs`（加 `pub mod logging;`）
- Modify: `noj-judge/src/main.rs:88-97`（替换 `tracing_subscriber::fmt()` 初始化）
- Test: 单元测试内联在 `logging.rs` 的 `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: 无（自包含；不新增 crate 依赖）。
- Produces（供 `main.rs` 与后续使用）:
  - `pub const SGR_RESET/DIM/BOLD: &str`
  - `pub fn resolve_color_from(no_color: Option<&str>, log_color: Option<&str>, is_tty: bool) -> bool`
  - `pub fn resolve_color(is_tty: bool) -> bool`
  - `pub fn timestamp_hms() -> String`、`pub fn timestamp_hms_from(t: SystemTime) -> String`
  - `pub struct ContractFormat { pub color: bool }`（实现 `FormatEvent`）
  - `pub struct LevelSplitWriter`（实现 `MakeWriter`，warn/error → stderr）
  - `pub fn build_filter() -> EnvFilter`（`RUST_LOG` 优先，回退 `LOG_LEVEL`）
  - `pub fn init()`

- [ ] **Step 1: 写失败测试**

创建 `noj-judge/src/logging.rs`，**先只写测试模块与空实现**：

```rust
//! 日志呈现层：契约布局、着色判定、按级别分流。
//!
//! 视觉契约见 `dev-docs/engineering/log-conventions.md`。
//!
//! 注意：Rust 1.96 起 `std::env::set_var` / `remove_var` 是 `unsafe`，
//! 因此着色判定抽出纯函数内核 `resolve_color_from` 供测试；测试**不得**
//! 修改进程环境。

use std::io::{self, IsTerminal, Write};
use std::time::SystemTime;
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::fmt::{format::Writer, FmtContext, FormatEvent, FormatFields};
use tracing_subscriber::registry::LookupSpan;

pub const SGR_RESET: &str = "\x1b[0m";
pub const SGR_DIM: &str = "\x1b[2m";
pub const SGR_BOLD: &str = "\x1b[1m";

/// 按级别取 SGR 颜色码（契约 §1）。
pub fn level_sgr(level: &Level) -> &'static str {
    match *level {
        Level::ERROR => "\x1b[1;31m",
        Level::WARN => "\x1b[1;33m",
        Level::INFO => "\x1b[36m",
        Level::DEBUG | Level::TRACE => "\x1b[90m",
    }
}

/// 契约级别徽章（`padEnd(5)` 语义：WARN/INFO 带尾空格）。
pub fn level_badge(level: &Level) -> &'static str {
    match *level {
        Level::ERROR => "ERROR",
        Level::WARN => "WARN ",
        Level::INFO => "INFO ",
        Level::DEBUG | Level::TRACE => "DEBUG",
    }
}

/// 着色策略纯函数内核（契约 §3）。
pub fn resolve_color_from(
    no_color: Option<&str>,
    log_color: Option<&str>,
    is_tty: bool,
) -> bool {
    if no_color.map(|v| !v.is_empty()).unwrap_or(false) {
        return false;
    }
    match log_color {
        Some("never") => false,
        Some("always") => true,
        _ => is_tty,
    }
}

/// 从进程环境读取并按契约判定是否着色。
pub fn resolve_color(is_tty: bool) -> bool {
    let no_color = std::env::var("NO_COLOR").ok();
    let log_color = std::env::var("LOG_COLOR").ok();
    resolve_color_from(no_color.as_deref(), log_color.as_deref(), is_tty)
}

/// 当前时刻的 `HH:MM:SS.mmm`（UTC，不新增依赖）。
pub fn timestamp_hms() -> String {
    timestamp_hms_from(SystemTime::now())
}

/// 由给定时刻渲染 `HH:MM:SS.mmm`（UTC）。
pub fn timestamp_hms_from(t: SystemTime) -> String {
    let d = t.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs();
    let ms = d.subsec_millis();
    let day = secs % 86_400;
    let (h, m, s) = (day / 3600, (day % 3600) / 60, day % 60);
    format!("{h:02}:{m:02}:{s:02}.{ms:03}")
}

/// 采集事件字段。
#[derive(Default)]
struct FieldVisitor {
    message: Option<String>,
    fields: Vec<(String, String)>,
}

impl tracing::field::Visit for FieldVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        let rendered = format!("{value:?}");
        if field.name() == "message" {
            // tracing 的 message 字段经 Debug 渲染会带引号，去掉
            self.message = Some(rendered.trim_matches('"').to_string());
        } else {
            self.fields.push((field.name().to_string(), rendered));
        }
    }
}

/// 契约布局的 `FormatEvent` 实现。
pub struct ContractFormat {
    pub color: bool,
}

impl<S, N> FormatEvent<S, N> for ContractFormat
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        _ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> std::fmt::Result {
        let level = event.metadata().level();
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);

        let ts = timestamp_hms();
        if self.color {
            write!(writer, "{SGR_DIM}{ts}{SGR_RESET}  ")?;
            write!(writer, "{}{}{SGR_RESET}", level_sgr(level), level_badge(level))?;
        } else {
            write!(writer, "{ts}  {}", level_badge(level))?;
        }
        write!(writer, "  {}", visitor.message.unwrap_or_default())?;
        for (k, v) in &visitor.fields {
            if self.color {
                write!(writer, "  {SGR_DIM}{k}={SGR_RESET}{v}")?;
            } else {
                write!(writer, "  {k}={v}")?;
            }
        }
        let bold = self.color && matches!(*level, Level::WARN | Level::ERROR);
        if bold {
            write!(writer, "{SGR_BOLD}")?;
        }
        writeln!(writer)
    }
}

/// 按级别分流的 writer（warn/error → stderr，其余 → stdout）。
pub struct LevelSplitWriter;

/// 一次事件的输出目标。
pub struct LevelWriter {
    stderr: bool,
}

impl Write for LevelWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.stderr {
            io::stderr().write(buf)
        } else {
            io::stdout().write(buf)
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        if self.stderr {
            io::stderr().flush()
        } else {
            io::stdout().flush()
        }
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LevelSplitWriter {
    type Writer = LevelWriter;
    fn make_writer(&'a self) -> Self::Writer {
        LevelWriter { stderr: false }
    }
    fn make_writer_for(&'a self, meta: &tracing::metadata::Metadata<'_>) -> Self::Writer {
        LevelWriter {
            stderr: matches!(*meta.level(), Level::WARN | Level::ERROR),
        }
    }
}

/// 级别过滤：`RUST_LOG` 优先，未设置时回退 `LOG_LEVEL`。
///
/// `EnvFilter` 解析的是过滤指令语法（如 `info,noj_judge=debug`），
/// 裸级别名同样合法。
pub fn build_filter() -> tracing_subscriber::EnvFilter {
    if let Ok(f) = tracing_subscriber::EnvFilter::try_from_default_env() {
        return f;
    }
    let directive = match std::env::var("LOG_LEVEL")
        .unwrap_or_else(|_| "info".to_string())
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "debug" => "debug",
        "warn" => "warn",
        "error" => "error",
        _ => "info",
    };
    tracing_subscriber::EnvFilter::new(directive)
}

/// 装配全局 subscriber。
///
/// 修复既有缺陷：原实现使用 `tracing_subscriber::fmt()` 的默认 ansi 推导
/// （只认 `NO_COLOR`、不探测 TTY），在 `driver: json-file` 下把 ANSI 转义码
/// 原样写入日志文件。
pub fn init() {
    let color = resolve_color(io::stdout().is_terminal() || io::stderr().is_terminal());
    // 注意：不要调用 `.with_ansi(...)` —— 该方法只存在于默认 formatter 的
    // builder（`SubscriberBuilder<N, Format<L,T>, F, W>`）上；改用自定义
    // `event_format` 后 builder 类型变为 `SubscriberBuilder<N, ContractFormat, F, W>`，
    // 调用它会编译失败。着色完全由 `ContractFormat { color }` 自行产生。
    tracing_subscriber::fmt()
        .with_env_filter(build_filter())
        .event_format(ContractFormat { color })
        .with_writer(LevelSplitWriter)
        .init();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, UNIX_EPOCH};
    use tracing_subscriber::fmt::MakeWriter;

    #[test]
    fn color_policy_order() {
        assert!(!resolve_color_from(None, None, false));
        assert!(resolve_color_from(None, None, true));
        assert!(resolve_color_from(None, Some("always"), false));
        assert!(!resolve_color_from(None, Some("never"), true));
        assert!(!resolve_color_from(Some("1"), Some("always"), true));
        assert!(resolve_color_from(Some(""), None, true));
        assert!(resolve_color_from(None, Some("bogus"), true));
    }

    #[test]
    fn timestamp_is_hms_millis() {
        let t = UNIX_EPOCH + Duration::from_millis(3_600_000 + 120_000 + 7_000 + 412);
        assert_eq!(timestamp_hms_from(t), "01:02:07.412");
        assert_eq!(timestamp_hms_from(UNIX_EPOCH), "00:00:00.000");
        let end = UNIX_EPOCH + Duration::from_millis(86_399_999);
        assert_eq!(timestamp_hms_from(end), "23:59:59.999");
        assert_eq!(timestamp_hms_from(end).len(), 12);
    }

    #[test]
    fn badge_matches_contract_width() {
        assert_eq!(level_badge(&Level::INFO).len(), 5);
        assert_eq!(level_badge(&Level::WARN).len(), 5);
        assert_eq!(level_badge(&Level::ERROR).len(), 5);
        assert_eq!(level_badge(&Level::DEBUG).len(), 5);
    }

    /// 收集指定流的输出。
    struct Buf(Arc<Mutex<Vec<u8>>>);
    impl Write for Buf {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    #[derive(Clone)]
    struct Split(Arc<Mutex<Vec<u8>>>, Arc<Mutex<Vec<u8>>>);
    impl<'a> MakeWriter<'a> for Split {
        type Writer = Buf;
        fn make_writer(&'a self) -> Buf {
            Buf(self.0.clone())
        }
        fn make_writer_for(&'a self, m: &tracing::metadata::Metadata<'_>) -> Buf {
            if matches!(*m.level(), Level::WARN | Level::ERROR) {
                Buf(self.1.clone())
            } else {
                Buf(self.0.clone())
            }
        }
    }

    #[test]
    fn writes_contract_layout_and_splits_streams() {
        let out = Arc::new(Mutex::new(Vec::new()));
        let err = Arc::new(Mutex::new(Vec::new()));
        let sub = tracing_subscriber::fmt::Subscriber::builder()
            .with_env_filter(tracing_subscriber::EnvFilter::new("trace"))
            .event_format(ContractFormat { color: false })
            .with_writer(Split(out.clone(), err.clone()))
            .finish();
        tracing::subscriber::with_default(sub, || {
            tracing::info!(submission_id = %"abc", "入队");
            tracing::warn!(error = %"boom", "失败");
        });
        let o = String::from_utf8(out.lock().unwrap().clone()).unwrap();
        let e = String::from_utf8(err.lock().unwrap().clone()).unwrap();
        assert!(o.contains("INFO "), "stdout 应含 INFO 徽章: {o:?}");
        assert!(o.contains("submission_id"), "stdout 应含结构化字段: {o:?}");
        assert!(o.contains("入队"));
        assert!(e.contains("WARN "), "stderr 应含 WARN: {e:?}");
        assert!(e.contains("失败"));
        assert!(!o.contains('\u{1b}'), "无色模式不得有转义");
        assert!(!e.contains('\u{1b}'));
        // 时间戳位于行首，形如 HH:MM:SS.mmm
        assert_eq!(&o[..12], &timestamp_hms()[..12]);
        assert_eq!(o.as_bytes()[2], b':');
    }

    #[test]
    fn contract_format_emits_sgr_when_colored() {
        let out = Arc::new(Mutex::new(Vec::new()));
        let err = Arc::new(Mutex::new(Vec::new()));
        let sub = tracing_subscriber::fmt::Subscriber::builder()
            .with_env_filter(tracing_subscriber::EnvFilter::new("trace"))
            .event_format(ContractFormat { color: true })
            .with_writer(Split(out.clone(), err.clone()))
            .finish();
        tracing::subscriber::with_default(sub, || {
            tracing::error!(x = 1, "出错");
        });
        let e = String::from_utf8(err.lock().unwrap().clone()).unwrap();
        assert!(e.contains("\u{1b}[1;31m"), "ERROR 应为粗体红: {e:?}");
        assert!(e.contains("\u{1b}[0m"));
    }
}
```

- [ ] **Step 2: 编译并运行测试**

```bash
cd noj-judge && cargo test --lib logging 2>&1 | tail -20
```

预期：6 个测试全 PASS。若编译失败，按提示修正——常见问题是 `Level::TRACE` 在 `matches!` 中的穷尽性（`Level` 是非穷尽枚举，必须用 `_ =>` 兜底）。

- [ ] **Step 3: 接入 lib.rs**

编辑 `noj-judge/src/lib.rs`，在 `pub mod judge;` 之后插入：

```rust
pub mod logging;
```

- [ ] **Step 4: 替换 main.rs 的初始化**

把 `noj-judge/src/main.rs` 第 91–96 行的：

```rust
        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,noj_judge=debug")),
            )
            .init();
```

替换为：

```rust
        // 契约化日志：布局/配色/分流见 noj_judge::logging 与
        // dev-docs/engineering/log-conventions.md。
        // 修复既有缺陷：原 `tracing_subscriber::fmt()` 的默认 ansi 推导只认
        // NO_COLOR、不探测 TTY，会把 ANSI 转义码写进 json-file 日志。
        noj_judge::logging::init();
```

注意：原来的默认过滤器是 `"info,noj_judge=debug"`，新的 `build_filter()` 在 `RUST_LOG` 未设置时回退到 `LOG_LEVEL`（默认 `info`）。**保留了 `RUST_LOG` 优先级**，因此部署侧原本通过 `RUST_LOG` 设置的 per-target 调试不受影响。

- [ ] **Step 5: 编译与全量测试**

```bash
cd noj-judge && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo nextest run --all-targets
```

预期：无 warning；测试全 PASS（E2E 测试因 `#[ignore]` 跳过）。

- [ ] **Step 6: 手工验证缺陷 1 已修复**

```bash
cd noj-judge && cargo run 2>&1 | cat | head -20
```

预期：输出**不含** `\x1b[`（管道非 TTY）。用以下命令确认：

```bash
cd noj-judge && LOG_LEVEL=info timeout 5 cargo run 2>&1 | cat | grep -c $'\x1b\[' || echo "0 转义码（已修复）"
```

再验证强制着色：

```bash
cd noj-judge && LOG_COLOR=always LOG_LEVEL=info timeout 5 cargo run 2>&1 | cat | head -5 | cat -v | head -5
```

预期：可见 `^[[2m` 之类转义序列（证明 `LOG_COLOR=always` 生效）。

- [ ] **Step 7: 提交**

```bash
jj describe -m "feat(judge): 日志契约化布局与按级别分流，修复 ANSI 写入结构化日志"
jj new
```

---

### Task 7: noj-llm-gateway 新建 logger 与上下文

**Files:**
- Create: `noj-llm-gateway/src/logger.ts`
- Create: `noj-llm-gateway/src/context.ts`
- Create: `noj-llm-gateway/tests/logger_test.ts`
- Modify: `noj-llm-gateway/src/app.ts`（挂 request_id 中间件）
- Modify: `noj-llm-gateway/src/routes/llm.ts:99-117`（替换 `console.warn`，修脱敏）
- Modify: `noj-llm-gateway/src/main.ts`（装配 logger）
- Modify: `noj-llm-gateway/src/config-registry.ts`（登记 `LOG_LEVEL`/`LOG_FORMAT`/`LOG_COLOR`）
- Modify: `noj-llm-gateway/deno.json`（加 LogTape 依赖）
- Modify: `noj-llm-gateway/.env.example` 与根 `.env.prod.example`

**Interfaces:**
- Consumes: 无（网关侧独立装配；与 core 的 `log-format.ts` **不共享代码**——两个 Deno 模块各自独立部署，跨模块相对导入会破坏 `deno check` 与 exports 边界）。
- Produces:
  - `src/context.ts`: `runWithRequestId<T>(id: string, fn: () => T): T`、`getRequestId(): string | undefined`、`requestIdMiddleware(): MiddlewareHandler`
  - `src/logger.ts`: `setupGatewayLogging(): void`、`logger: { debug, info, warn, error }`（签名 `(msg: string, fields?: Record<string, unknown>) => void`）、`redactFields`、`resolveColor`、`resolveFormat`

- [ ] **Step 1: 加依赖**

编辑 `noj-llm-gateway/deno.json` 的 `imports`，在 `"@std/encoding"` 前加入：

```json
    "@logtape/logtape": "jsr:@logtape/logtape@^2.3.4",
```

- [ ] **Step 2: 写失败测试**

创建 `noj-llm-gateway/tests/logger_test.ts`：

```ts
import { assertEquals, assertStrictEquals } from "@std/assert";
import { configureSync, getLogger, type LogRecord, type Sink } from "@logtape/logtape";
import {
  makeGatewayJsonFormatter,
  makeGatewayPrettyFormatter,
  redactFields,
  resolveColor,
} from "../src/logger.ts";
import { getRequestId, runWithRequestId } from "../src/context.ts";

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

function capture(fn: () => void): LogRecord[] {
  const seen: LogRecord[] = [];
  const sink: Sink = (r) => { seen.push(r); };
  configureSync({
    reset: true,
    sinks: { cap: sink },
    filters: {},
    loggers: [
      { category: [], sinks: ["cap"], lowestLevel: "trace" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "fatal" },
    ],
  });
  fn();
  return seen;
}

Deno.test("gateway logger: 生产环境抹除网关特有敏感键", () => {
  withEnv({ NOJ_ENV: "production" }, () => {
    const out = redactFields({
      api_key: "sk-live-123",
      encrypted_api_key: "enc",
      eval_token: "tok",
      service_token: "svc",
      store_key: "key",
      submission_id: "550e8400-e29b-41d4-a716-446655440000",
      status: "ok",
    });
    assertEquals(out.api_key, "[redacted]");
    assertEquals(out.encrypted_api_key, "[redacted]");
    assertEquals(out.eval_token, "[redacted]");
    assertEquals(out.service_token, "[redacted]");
    assertEquals(out.store_key, "[redacted]");
    assertEquals(out.submission_id, "550e8400...");
    assertEquals(out.status, "ok");
  });
});

Deno.test("gateway logger: 开发环境不脱敏", () => {
  withEnv({ NOJ_ENV: "development" }, () => {
    const out = redactFields({ api_key: "sk-live-123" });
    assertEquals(out.api_key, "sk-live-123");
  });
});

Deno.test("gateway logger: resolveColor 遵循契约判定顺序", () => {
  withEnv({ LOG_FORMAT: undefined, LOG_COLOR: "always", NO_COLOR: undefined }, () => {
    assertEquals(resolveColor("stdout"), true);
  });
  withEnv({ LOG_COLOR: "never" }, () => assertEquals(resolveColor("stdout"), false));
  withEnv({ LOG_COLOR: "always", NO_COLOR: "1" }, () =>
    assertEquals(resolveColor("stdout"), false));
  withEnv({ LOG_FORMAT: "json", LOG_COLOR: "always", NO_COLOR: undefined }, () =>
    assertEquals(resolveColor("stdout"), false));
});

Deno.test("gateway context: request_id 跨 await 传播", async () => {
  let seen: string | undefined;
  await runWithRequestId("gw-req-1", async () => {
    await new Promise((r) => setTimeout(r, 5));
    seen = getRequestId();
  });
  assertEquals(seen, "gw-req-1");
  assertEquals(getRequestId(), undefined, "上下文外应为 undefined");
});

Deno.test("gateway logger: pretty 无转义且含级别徽章", () => {
  const records = capture(() => {
    getLogger(["noj", "gateway"]).info("代理调用 {model}", { model: "gpt-4o" });
  });
  const line = makeGatewayPrettyFormatter({ color: false, production: false })(records[0]!);
  assertStrictEquals(/\x1b\[/.test(line), false);
  assertEquals(line.includes("INFO "), true, line);
  assertEquals(line.includes("代理调用 gpt-4o"), true, line);
});

Deno.test("gateway logger: JSON 形状为 core 契约", () => {
  const records = capture(() => {
    getLogger(["noj", "gateway"]).warn("限流 {model}", { model: "gpt-4o", limit: 10 });
  });
  const parsed = JSON.parse(makeGatewayJsonFormatter()(records[0]!)) as Record<string, unknown>;
  assertEquals(parsed.level, "warn");
  assertEquals(parsed.msg, "限流 gpt-4o");
  assertEquals(parsed.model, "gpt-4o");
  assertEquals(parsed.limit, 10);
  assertEquals("properties" in parsed, false);
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd noj-llm-gateway && deno task test
```

预期：FAIL，`Module not found ... src/logger.ts`。

- [ ] **Step 4: 实现 context.ts**

创建 `noj-llm-gateway/src/context.ts`：

```ts
/**
 * 请求上下文（AsyncLocalStorage）。
 *
 * 与 noj-core 的 `shared/observability/context.ts` 语义一致，但**独立实现**：
 * 两个 Deno 模块各自部署，跨模块相对导入会破坏 exports 边界。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";

/** LogTape 读取的上下文字段名。 */
export const REQUEST_ID_KEY = "request_id";

const store = new AsyncLocalStorage<Record<string, unknown>>();

/** 供 LogTape 的 `contextLocalStorage` 使用。 */
export const gatewayContextStorage = store;

/** 在带 `request_id` 的上下文中执行 `fn`。 */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return store.run({ [REQUEST_ID_KEY]: requestId }, fn);
}

/** 读取当前 `request_id`（不在请求上下文中时返回 undefined）。 */
export function getRequestId(): string | undefined {
  const v = store.getStore()?.[REQUEST_ID_KEY];
  return typeof v === "string" ? v : undefined;
}

/**
 * 生成或透传 `X-Request-Id`，并用其包裹后续处理。
 *
 * 透传客户端提供的 ID 便于跨服务串联；无则生成 UUID。
 */
export function requestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId = incoming && incoming.length > 0 && incoming.length <= 128
      ? incoming
      : crypto.randomUUID();
    c.header("X-Request-Id", requestId);
    return await runWithRequestId(requestId, () => next());
  };
}
```

- [ ] **Step 5: 实现 logger.ts**

创建 `noj-llm-gateway/src/logger.ts`。**与 core 的 `log-format.ts` 内容同构**，差异仅在 category 前缀与敏感键集合（已合并入同一集合，见 Task 2 的实现）：

```ts
/**
 * noj-llm-gateway 日志装配与渲染。
 *
 * 视觉契约见 `dev-docs/engineering/log-conventions.md`。
 * 渲染规则与 noj-core 的 `shared/base/log-format.ts` 同构，但**独立实现**。
 *
 * LogTape 实测行为（改动前请读计划 Global Constraints）：
 * - `record.message` 是交错数组；插值键仍留在 `properties`；
 * - 级别字符串是 `warning` 而非 `warn`；
 * - `getTextFormatter` 的 `format` 必须是函数。
 */

import {
  configureSync,
  getConsoleSink,
  getLogger,
  getTextFormatter,
  type LogRecord as LtRecord,
} from "@logtape/logtape";
import { gatewayContextStorage } from "./context.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SGR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  info: "\x1b[36m",
  debug: "\x1b[90m",
  warn: "\x1b[1;33m",
  error: "\x1b[1;31m",
} as const;

/** 生产环境判定。 */
export function isProduction(): boolean {
  return Deno.env.get("NOJ_ENV") === "production";
}

/** 解析级别（生产 warn，否则 debug）。 */
export function resolveLevel(): LogLevel {
  const raw = Deno.env.get("LOG_LEVEL")?.trim().toLowerCase();
  if (raw && Object.prototype.hasOwnProperty.call(LEVEL_ORDER, raw)) {
    return raw as LogLevel;
  }
  return isProduction() ? "warn" : "debug";
}

/** 解析格式（生产 json，否则 pretty）。 */
export function resolveFormat(): "json" | "pretty" {
  const raw = Deno.env.get("LOG_FORMAT")?.trim().toLowerCase();
  if (raw === "json" || raw === "pretty") return raw;
  return isProduction() ? "json" : "pretty";
}

/** 解析着色策略。 */
export function describeColorPolicy(): "off" | "on" | "auto" {
  const raw = Deno.env.get("LOG_COLOR")?.trim().toLowerCase();
  if (raw === "never") return "off";
  if (raw === "always") return "on";
  return "auto";
}

function isTty(stream: "stdout" | "stderr"): boolean {
  try {
    return stream === "stderr"
      ? Deno.stderr.isTerminal()
      : Deno.stdout.isTerminal();
  } catch {
    return false;
  }
}

/** 判定某流是否着色（契约 §3）。 */
export function resolveColor(stream: "stdout" | "stderr"): boolean {
  if (resolveFormat() === "json") return false;
  const noColor = Deno.env.get("NO_COLOR");
  if (noColor !== undefined && noColor !== "") return false;
  switch (describeColorPolicy()) {
    case "off":
      return false;
    case "on":
      return true;
    default:
      return isTty(stream);
  }
}

/** LogTape 级别名 → 契约级别名。 */
export function toCoreLevel(lt: string): LogLevel {
  switch (lt) {
    case "trace":
    case "debug":
      return "debug";
    case "warning":
    case "warn":
      return "warn";
    case "error":
    case "fatal":
      return "error";
    default:
      return "info";
  }
}

/** 按出现顺序解析占位符（`{{` 转义不参与）。 */
export function orderedPlaceholders(raw: string | readonly string[]): string[] {
  const text = typeof raw === "string" ? raw : raw.join("\u0000");
  const cleaned = text.replace(/\{\{/g, "").replace(/\}\}/g, "");
  return [...cleaned.matchAll(/\{([^{}]*)\}/g)]
    .map((m) => m[1]!.trim())
    .filter((k) => k.length > 0);
}

/**
 * 敏感键集合。
 *
 * 复用 core 的集合，并补齐网关特有键（契约 §6）。
 */
const SENSITIVE_KEYS = new Set([
  "password",
  "password_hash",
  "token",
  "token_hash",
  "secret",
  "code",
  "email",
  "authorization",
  "cookie",
  "jwt",
  "api_key",
  "encrypted_api_key",
  "eval_token",
  "service_token",
  "store_key",
]);

const ID_KEYS = new Set([
  "submission_id",
  "user_id",
  "problem_id",
  "conversation_id",
  "message_id",
]);

/** 截断 ID。 */
export function redactId(id: string, visiblePrefix = 8): string {
  if (!id || id.length <= visiblePrefix) return "[redacted]";
  return `${id.slice(0, visiblePrefix)}...`;
}

/** Error → 契约形状。 */
export function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return isProduction()
      ? { name: value.name, message: value.message }
      : { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/** 按字段名脱敏单个值。 */
export function redactValueByKey(key: string, value: unknown): unknown {
  if (!isProduction()) return serializeValue(value);
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) return "[redacted]";
  if (lower === "score") return "[redacted]";
  if (ID_KEYS.has(lower) || lower.endsWith("_id")) {
    return typeof value === "string" ? redactId(value) : serializeValue(value);
  }
  return serializeValue(value);
}

/** 对字段对象脱敏。 */
export function redactFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!isProduction()) {
      out[key] = serializeValue(value);
      continue;
    }
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lower)) {
      out[key] = "[redacted]";
      continue;
    }
    if (lower === "score") continue;
    if (ID_KEYS.has(lower) || lower.endsWith("_id")) {
      out[key] = typeof value === "string" ? redactId(value) : serializeValue(value);
      continue;
    }
    out[key] = serializeValue(value);
  }
  return out;
}

/** 渲染字段值（字符串不加引号）。 */
export function formatFieldValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** 重建 message，对插值位置逐值脱敏。 */
export function renderableMessage(record: LtRecord): string {
  const parts = record.message as readonly unknown[];
  const ordered = orderedPlaceholders(record.rawMessage as string | readonly string[]);
  const out: string[] = [];
  let vi = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) out.push(String(parts[i] ?? ""));
    else out.push(formatFieldValue(redactValueByKey(ordered[vi++] ?? "", parts[i])));
  }
  return out.join("");
}

/** 呈现字段（排除插值键与 request_id）。 */
export function renderableFields(record: LtRecord): [string, unknown][] {
  const skip = new Set(
    orderedPlaceholders(record.rawMessage as string | readonly string[]),
  );
  skip.add("request_id");
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record.properties)) {
    if (!skip.has(k)) kept[k] = v;
  }
  return Object.entries(redactFields(kept));
}

const TIME_WIDTH = 12;
const LEVEL_WIDTH = 5;
const MSG_COLUMN = TIME_WIDTH + 2 + LEVEL_WIDTH + 2;

/** 契约 pretty 布局。 */
export function formatPretty(
  values: { timestamp: string | null; record: LtRecord },
  opts: { color: boolean },
): string {
  const record = values.record;
  const level = toCoreLevel(record.level);
  const time = values.timestamp ?? "";
  const rid = typeof record.properties.request_id === "string"
    ? record.properties.request_id.slice(0, 8)
    : undefined;

  const parts: string[] = [];
  parts.push(opts.color ? `${SGR.dim}${time}${SGR.reset}` : time, "  ");
  const badge = level.toUpperCase().padEnd(LEVEL_WIDTH);
  parts.push(opts.color ? `${SGR[level]}${badge}${SGR.reset}` : badge, "  ");

  const indent = " ".repeat(MSG_COLUMN);
  parts.push(renderableMessage(record).split("\n").join(`\n${indent}`));

  if (rid) {
    parts.push("  ", opts.color ? `${SGR.dim}rid=${rid}${SGR.reset}` : `rid=${rid}`);
  }
  const entries = renderableFields(record);
  if (entries.length > 0) {
    parts.push(
      "  ",
      entries
        .map(([k, v]) =>
          opts.color
            ? `${SGR.dim}${k}=${SGR.reset}${formatFieldValue(v)}`
            : `${k}=${formatFieldValue(v)}`
        )
        .join("  "),
    );
  }
  const line = parts.join("");
  return opts.color && (level === "warn" || level === "error")
    ? `${SGR.bold}${line}${SGR.reset}`
    : line;
}

/** 构造 pretty formatter。 */
export function makeGatewayPrettyFormatter(
  opts: { color: boolean; production?: boolean },
): (record: LtRecord) => string {
  return getTextFormatter({
    timestamp: "time",
    value: (v: unknown) => formatFieldValue(v),
    format: (values) => formatPretty(values, { color: opts.color }),
  });
}

/** 构造 core 契约形状的 JSON formatter。 */
export function makeGatewayJsonFormatter(): (record: LtRecord) => string {
  return (record: LtRecord): string => {
    const fields = redactFields(record.properties);
    const rid = fields.request_id;
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === "request_id") continue;
      rest[k] = v instanceof Error ? serializeValue(v) : v;
    }
    return JSON.stringify({
      ts: new Date(record.timestamp).toISOString(),
      level: toCoreLevel(record.level),
      msg: renderableMessage(record),
      ...(rid === undefined ? {} : { request_id: rid }),
      ...rest,
    });
  };
}

/** 动态级别过滤。 */
function dynamicLevelFilter(record: LtRecord): boolean {
  return LEVEL_ORDER[toCoreLevel(record.level)] >= LEVEL_ORDER[resolveLevel()];
}

/** 装配网关 LogTape。幂等，可重复调用。 */
export function setupGatewayLogging(): void {
  const format = resolveFormat();
  const makeFormatter = (stream: "stdout" | "stderr") =>
    format === "json"
      ? makeGatewayJsonFormatter()
      : makeGatewayPrettyFormatter({ color: resolveColor(stream), production: isProduction() });
  const outFormatter = makeFormatter("stdout");
  const errFormatter = makeFormatter("stderr");

  // 用 getConsoleSink 而非 getStreamSink：后者带异步 disposer，configureSync
  // 会抛 ConfigError；且 getConsoleSink 同步写出，Deno.exit 下不丢日志。
  // console sink 自身按级别把 warn/error 送到 stderr、其余送到 stdout。
  const consoleSink = getConsoleSink({
    formatter: (record: LtRecord) => {
      const level = toCoreLevel(record.level);
      const isErr = level === "warn" || level === "error";
      return (isErr ? errFormatter : outFormatter)(record);
    },
  });

  configureSync({
    reset: true,
    sinks: { target: consoleSink },
    filters: { level: dynamicLevelFilter },
    contextLocalStorage: gatewayContextStorage,
    loggers: [
      { category: [], sinks: ["target"], filters: ["level"], lowestLevel: "trace" },
      { category: ["logtape", "meta"], sinks: ["target"], lowestLevel: "warning" },
    ],
  });
}

/** 网关 logger（category 固定为 `noj:gateway`）。 */
export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) =>
    getLogger(["noj", "gateway"]).debug(msg, fields ?? {}),
  info: (msg: string, fields?: Record<string, unknown>) =>
    getLogger(["noj", "gateway"]).info(msg, fields ?? {}),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    getLogger(["noj", "gateway"]).warn(msg, fields ?? {}),
  error: (msg: string, fields?: Record<string, unknown>) =>
    getLogger(["noj", "gateway"]).error(msg, fields ?? {}),
};
```

- [ ] **Step 6: 运行测试确认通过**

```bash
cd noj-llm-gateway && deno task test
```

预期：新增 6 个测试 PASS，既有测试仍 PASS。

- [ ] **Step 6b: 替换其余 3 处裸 console 调用**

spec §8 要求替换**全部 4 处**裸 `console`，Step 7 只处理了 `routes/llm.ts` 那处安全相关
的。另外 3 处在迁移/种子路径，一并替换：

`noj-llm-gateway/src/db/seed.ts`（约第 73 行）：

```ts
    logger.info("已写入默认配额", {
      scope_type: q.scope_type,
      window_type: q.window_type,
    });
```

`noj-llm-gateway/src/db/migrate.ts`（约第 43 行）：

```ts
      logger.info("已应用迁移", { file });
```

`noj-llm-gateway/src/db/migrate-cli.ts`（全部内容）：

```ts
import { loadConfig } from "../config.ts";
import { runMigrations } from "./migrate.ts";
import { logger, setupGatewayLogging } from "../logger.ts";

setupGatewayLogging();
const config = loadConfig();
await runMigrations(config.databaseUrl);
logger.info("LLM gateway 迁移完成");
```

两个文件都需要在顶部加：

```ts
import { logger } from "../logger.ts";
```

替换后确认无遗留：

```bash
cd noj-llm-gateway && rg -n 'console\.(log|warn|error)' src/
```

预期：无输出。

> 注意：这 3 处若不加 `setupGatewayLogging()`，LogTape 会用默认配置（输出到 console 且
> 无级别过滤），行为仍正确——但 `migrate-cli.ts` 作为独立入口应显式装配，以保持与
> `main.ts` 一致。

- [ ] **Step 7: 挂中间件并替换 console**

编辑 `noj-llm-gateway/src/app.ts`：在 `import { renderMetrics } from "./metrics.ts";` 之后加：

```ts
import { requestIdMiddleware } from "./context.ts";
```

在 `const app = new Hono();` 之后加：

```ts
  // 为所有请求注入 request_id，供 logger 自动附带（契约 §2 的 rid 字段）
  app.use("*", requestIdMiddleware());
```

编辑 `noj-llm-gateway/src/routes/llm.ts`：

顶部加入：

```ts
import { logger } from "../logger.ts";
```

把第 108–110 行的：

```ts
          console.warn(
            `[llm] eval_token 多来源 IP 调用: submission=${payload.submission_id} ip=${clientIp} ips=${ipCount}`,
          );
```

替换为：

```ts
          // 修复既有缺陷：原实现把 submission_id 与客户端 IP 明文写入日志，
          // 绕过全项目"生产日志脱敏"约定。改走 logger，由渲染层统一脱敏。
          logger.warn("eval_token 多来源 IP 调用", {
            submission_id: payload.submission_id,
            client_ip: clientIp,
            ip_count: ipCount,
          });
```

- [ ] **Step 8: 在 main.ts 装配**

编辑 `noj-llm-gateway/src/main.ts`，在 `import { loadConfig } from "./config.ts";` 之前加入：

```ts
import { setupGatewayLogging } from "./logger.ts";
```

在 `const config = loadConfig();` 之前加入：

```ts
setupGatewayLogging();
```

- [ ] **Step 9: 登记配置**

编辑 `noj-llm-gateway/src/config-registry.ts`，在 `GATEWAY_CONFIG_DEFINITIONS` 数组中 `NOJ_LLM_PORT` 条目之后加入三个条目：

```ts
  {
    key: "LOG_LEVEL",
    description: "日志级别（debug/info/warn/error；未设置按 NOJ_ENV 回退）",
    isSecret: false,
    readMode: "static",
  },
  {
    key: "LOG_FORMAT",
    description: "日志格式（json/pretty；未设置按 NOJ_ENV 回退）",
    isSecret: false,
    readMode: "static",
  },
  {
    key: "LOG_COLOR",
    description:
      "日志着色策略（auto/always/never；NO_COLOR 优先，LOG_FORMAT=json 时恒无色）",
    isSecret: false,
    readMode: "static",
  },
```

编辑 `noj-llm-gateway/.env.example`，在 `# NOJ_LLM_PORT=8001` 之后加入：

```
# 日志（与 noj-core 同一套约定，见 dev-docs/engineering/log-conventions.md）
# 级别：debug / info / warn / error（默认按 NOJ_ENV 回退）
# LOG_LEVEL=info
# 格式：json（结构化）/ pretty（人类可读）
# LOG_FORMAT=pretty
# 着色：auto（按 TTY）/ always / never；NO_COLOR 优先，json 格式恒无色
# LOG_COLOR=auto
```

编辑根 `.env.prod.example`，在 `LOG_FORMAT=json` 之后加入：

```
# 日志着色：auto（默认）/ always / never。生产 json 格式下恒无色，此项无效。
LOG_COLOR=auto
```

- [ ] **Step 10: 校验配置登记与静态检查**

```bash
cd noj-llm-gateway && deno fmt && deno lint && deno task check && deno task test
```

```bash
cd noj-core && deno task check:config-usage
```

预期：`check:config-usage` 通过，报告网关声明键从 9 增至 12。

> 若 `check:config-usage` 报 `LOG_LEVEL`/`LOG_FORMAT`/`LOG_COLOR` 为"盲区"（代码读了但未登记），说明 `config-registry.ts` 的条目没生效；若报"死键"（登记了但无人读），说明 `logger.ts` 中的 `Deno.env.get("LOG_LEVEL")` 等读取点被误删。两者都指向同一处接线。

- [ ] **Step 11: 手工验证**

```bash
cd noj-llm-gateway && deno task start > /tmp/gw.txt 2>&1 &
sleep 3 && kill %1
grep -c $'\x1b\[' /tmp/gw.txt || echo "0 转义码"
```

预期：0 转义码（重定向到文件时非 TTY）。

- [ ] **Step 12: 提交**

```bash
jj describe -m "feat(gateway): 引入 LogTape 日志与 request_id 上下文，修复未脱敏泄露"
jj new
```

---

### Task 8: noj-cli 着色策略

**Files:**
- Modify: `noj-cli/src/util/color.ts`
- Modify: `noj-cli/src/maintain/logs.ts`
- Modify: `noj-cli/src/cli.ts:144-164`（`parseMaintainArgs` 支持 `--color`）
- Modify: `noj-cli/src/cli.ts:313-327`（透传 color 选项）
- Modify: `noj-cli/src/mod.ts`（导出新增符号）
- Modify: `noj-cli/src/util/color_test.ts`（新增测试，既有 3 个断言保持不变）

**Interfaces:**
- Consumes: 无。
- Produces:
  - `type ColorMode = "auto" | "always" | "never"`
  - `resolveColor(mode: ColorMode, stream: "stdout" | "stderr"): boolean`
  - `colorFor(name: string): string`（**签名不变**）
  - `prefixLine(module: string, line: string, color: string, enabled?: boolean): string`（新增可选 `enabled`，默认 `true` 保持既有 3 个测试通过）
  - `LogsOptions` 新增 `color?: ColorMode`

- [ ] **Step 1: 写失败测试**

在 `noj-cli/src/util/color_test.ts` 末尾追加（**保留**既有 3 个测试不动）：

```ts
import { resolveColor } from "./color.ts";

/** 快照并恢复给定 env。 */
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

Deno.test("resolveColor: --color=always 强制开（无视 NO_COLOR 之外的判断）", () => {
  withEnv({ NO_COLOR: undefined, LOG_COLOR: undefined }, () => {
    assertEquals(resolveColor("always", "stdout"), true);
  });
});

Deno.test("resolveColor: --color=never 强制关", () => {
  withEnv({ NO_COLOR: undefined, LOG_COLOR: undefined }, () => {
    assertEquals(resolveColor("never", "stdout"), false);
  });
});

Deno.test("resolveColor: NO_COLOR 优先于 always", () => {
  withEnv({ NO_COLOR: "1" }, () => {
    assertEquals(resolveColor("always", "stdout"), false);
  });
});

Deno.test("resolveColor: LOG_COLOR=always 覆盖 auto", () => {
  withEnv({ NO_COLOR: undefined, LOG_COLOR: "always" }, () => {
    assertEquals(resolveColor("auto", "stdout"), true);
  });
});

Deno.test("resolveColor: NO_COLOR 空串不算设置", () => {
  withEnv({ NO_COLOR: "", LOG_COLOR: "always" }, () => {
    assertEquals(resolveColor("auto", "stdout"), true);
  });
});

Deno.test("prefixLine: enabled=false 时不加着色与前缀标记", () => {
  const out = prefixLine("server", "hello\n", "\x1b[36m", false);
  assertEquals(out, "[server] hello");
  assertEquals(out.includes("\x1b["), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd noj-cli && deno task test
```

预期：FAIL，`resolveColor` 未导出。

- [ ] **Step 3: 实现 color.ts**

把 `noj-cli/src/util/color.ts` 改为：

```ts
/** ANSI 重置码。 */
export const RESET = "\x1b[0m";

/** `--color` 取值（视觉契约 §3）。 */
export type ColorMode = "auto" | "always" | "never";

/** 固定调色板：8 种可读 ANSI 前景色。 */
const PALETTE = [
  "\x1b[36m", // cyan
  "\x1b[32m", // green
  "\x1b[33m", // yellow
  "\x1b[35m", // magenta
  "\x1b[34m", // blue
  "\x1b[31m", // red
  "\x1b[96m", // bright cyan
  "\x1b[92m", // bright green
];

/** 简单字符串哈希（FNV-1a 32 位），用于稳定取色。 */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 按模块名稳定取一个 ANSI 前景色码。 */
export function colorFor(name: string): string {
  return PALETTE[hash(name) % PALETTE.length]!;
}

/** 按流探测 TTY（无 TTY 支持的环境保守返回 false）。 */
function isTty(stream: "stdout" | "stderr"): boolean {
  try {
    return stream === "stderr"
      ? Deno.stderr.isTerminal()
      : Deno.stdout.isTerminal();
  } catch {
    return false;
  }
}

/**
 * 判定是否着色（视觉契约 §3）。
 *
 * 判定顺序：`NO_COLOR` 非空 → 关；`--color=never` / `LOG_COLOR=never` → 关；
 * `--color=always` / `LOG_COLOR=always` → 开；否则按流探测 TTY。
 *
 * 修复既有缺陷：`maintain logs` 原先**无条件**着色，`noj-cli logs > out.txt`
 * 会把转义码写进文件。
 */
export function resolveColor(
  mode: ColorMode,
  stream: "stdout" | "stderr" = "stdout",
): boolean {
  const noColor = Deno.env.get("NO_COLOR");
  if (noColor !== undefined && noColor !== "") return false;

  if (mode === "never") return false;
  if (mode === "always") return true;

  const envMode = Deno.env.get("LOG_COLOR")?.trim().toLowerCase();
  if (envMode === "never") return false;
  if (envMode === "always") return true;

  return isTty(stream);
}

/**
 * 给一行日志加彩色模块前缀；line 末尾换行会被去掉。
 *
 * `enabled=false` 时只加无色的 `[module]` 前缀，不产生任何转义序列。
 */
export function prefixLine(
  module: string,
  line: string,
  color: string,
  enabled = true,
): string {
  const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (!enabled) return `[${module}] ${trimmed}`;
  return `${color}[${module}] ${trimmed}${RESET}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd noj-cli && deno task test
```

预期：既有 3 个 + 新增 6 个测试全 PASS。

- [ ] **Step 5: 让 logs.ts 接入策略**

编辑 `noj-cli/src/maintain/logs.ts`：

顶部导入改为：

```ts
import { type ColorMode, colorFor, prefixLine, resolveColor } from "../util/color.ts";
```

`LogsOptions` 加入字段：

```ts
export interface LogsOptions {
  dir: string;
  modules: string[];
  follow: boolean;
  /** 着色模式；缺省 auto（按 TTY 探测） */
  color?: ColorMode;
  runner?: CommandRunner;
}
```

`maintainLogs` 整体替换为：

```ts
/** maintain logs 命令入口：非 follow 打印最近日志，follow 逐行打印。 */
export async function maintainLogs(opts: LogsOptions): Promise<number> {
  const mode: ColorMode = opts.color ?? "auto";
  // 修复既有缺陷：原实现无条件着色，重定向到文件时会把 ANSI 转义码写进文件。
  const enabled = resolveColor(mode, "stdout");
  const render = (module: string, line: string) =>
    prefixLine(module, line, colorFor(module), enabled);

  if (opts.follow) {
    await followLogs(opts, (module, line) => {
      console.log(render(module, line));
    });
    return 0;
  }
  const logs = await collectLogs(opts);
  for (const m of logs) {
    for (const line of m.lines) {
      console.log(render(m.module, line));
    }
  }
  return 0;
}
```

- [ ] **Step 6: 让 CLI 解析 --color**

编辑 `noj-cli/src/cli.ts` 的 `parseMaintainArgs`，把返回类型与解析逻辑替换为：

```ts
export function parseMaintainArgs(args: string[]): {
  dir: string | undefined;
  follow: boolean;
  modules: string | undefined;
  color: ColorMode | undefined;
} {
  let dir: string | undefined;
  let follow = false;
  let color: ColorMode | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dir") {
      dir = args[i + 1];
      i++;
    } else if (a === "--follow") {
      follow = true;
    } else if (a === "--color") {
      // 支持 `--color=always` 与 `--color always` 两种写法
      const v = args[i + 1];
      if (v === "auto" || v === "always" || v === "never") {
        color = v;
        i++;
      }
    } else if (a.startsWith("--color=")) {
      const v = a.slice("--color=".length);
      if (v === "auto" || v === "always" || v === "never") color = v;
    } else {
      positional.push(a);
    }
  }
  return { dir, follow, modules: positional[0], color };
}
```

在 `noj-cli/src/cli.ts` 顶部导入 `ColorMode` 类型：

```ts
import type { ColorMode } from "./util/color.ts";
```

把 `maintain logs` 分支里的：

```ts
        const { dir, follow, modules } = parseMaintainArgs(args.slice(1));
```

改为：

```ts
        const { dir, follow, modules, color } = parseMaintainArgs(args.slice(1));
```

并把：

```ts
          await maintainLogs({ dir: deployDir, modules: mods, follow });
```

改为：

```ts
          await maintainLogs({ dir: deployDir, modules: mods, follow, color });
```

- [ ] **Step 7: 更新导出**

编辑 `noj-cli/src/mod.ts`，把：

```ts
export { colorFor, prefixLine, RESET } from "./util/color.ts";
```

改为：

```ts
export { type ColorMode, colorFor, prefixLine, resolveColor, RESET } from "./util/color.ts";
```

- [ ] **Step 8: 全量检查**

```bash
cd noj-cli && deno fmt && deno task check && deno task test
```

预期：全部通过。

- [ ] **Step 9: 手工验证缺陷 2 已修复**

```bash
cd noj-cli && deno run -A src/cli.ts maintain logs --dir /tmp/nonexistent 2>&1 | head -3
```

再对一个真实部署目录验证（若有）：

```bash
cd noj-cli && deno run -A src/cli.ts maintain logs --dir <部署目录> > /tmp/cli.txt 2>&1
grep -c $'\x1b\[' /tmp/cli.txt || echo "0 转义码（已修复）"
cd noj-cli && deno run -A src/cli.ts maintain logs --dir <部署目录> --color=always | head -3 | cat -v
```

预期：第一条 0 转义码；第二条可见 `^[[36m` 之类（证明 `--color=always` 生效）。

- [ ] **Step 10: 提交**

```bash
jj describe -m "feat(root): noj-cli 日志着色接入契约策略并支持 --color"
jj new
```

---

### Task 9: Agent Note 与收尾验收

**Files:**
- Create: `.agents/notes/implemented/architecture/2026-09-12-unified-log-rendering-conventions.md`
- Modify: 无（其余为验证动作）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 决策记录 + 全链路验收结论。

- [ ] **Step 1: 写 Agent Note**

创建 `.agents/notes/implemented/architecture/2026-09-12-unified-log-rendering-conventions.md`：

```markdown
# Agent Note: 统一日志渲染与 LogTape 迁移

Status: implemented

## Problem

四个运行时（noj-core / noj-judge / noj-llm-gateway / noj-cli）的日志呈现互不相通：core
的自研 logger pretty 模式无颜色、judge 的 tracing 布局与 core 对不上、gateway 只有
4 处裸 `console`、cli 无条件着色。勘察中确认三个既有缺陷：

1. judge 向 `driver: json-file` 日志流灌 ANSI 转义码（`tracing-subscriber` 默认 ansi
   推导只认 `NO_COLOR`，不探测 TTY）；
2. `noj-cli logs > out.txt` 写入转义码（`maintainLogs` 无条件调 `prefixLine`）；
3. `gateway/routes/llm.ts` 明文输出 `submission_id` 与客户端 IP，绕过生产脱敏约定。

## Decision

- 建立跨运行时**视觉契约** `dev-docs/engineering/log-conventions.md`（SGR 语义、单行
  布局、着色判定顺序、脱敏不变量），作为单一事实源。
- noj-core 全量迁移到 **LogTape 2.3.4**（JSR，Deno 原生无兼容层），采用原生风格：
  `getLogger(["noj", "<module>"])` + 消息模板插值。48 文件 / 177 处调用点。
- `shared/base/logging.ts` 降级为**兼容层**：导出形状（`LogRecord`/`setLogSink`/
  `resetLogSink`/`redactId`）与语义不变，内部换 LogTape。这使得 8 个既有断言测试与
  6 个引用文件**零改动**通过。
- judge 继续用 `tracing` + `tracing-subscriber`（Rust 侧无对应物），自写
  `FormatEvent` 实现同一布局，`MakeWriter::make_writer_for` 按级别分流。
- 着色判定统一为 `NO_COLOR` → `LOG_COLOR`/`--color` → TTY，且 `LOG_FORMAT=json`
  恒无色（该规则优先于一切开关，专门防止缺陷 1 复发）。
- 字段去重（LogTape 插值键仍留在 `properties`）只发生在**呈现层**，不改变
  `LogRecord.fields`，以保住既有测试断言。

## Alternatives considered

- **pino**：Deno 下可用且有 `@pinojs/redact`，但属 Node 库，需 `--node-modules-dir`
  并引入原生模块（`sonic-boom`/`thread-stream`），且无 ALS 上下文与 category 等价能力。
- **OpenTelemetry logs**：API 可用但 SDK 未验证，且需自备人读 formatter 与脱敏，
  对"呈现层统一"的目标过重。
- **保留自研 API、内部换 LogTape**：改动面最小，但拿不到 category 模块名、
  `withContext` 与专用 sink 等完整能力。已明确选择全量迁移。
- **继续自研渲染层**：不引入依赖，但需手写时间格式化与级别过滤，且跨运行时一致性
  维护成本高。

## Consequences

- **静态校验成为必需**：LogTape 的占位符失败是**静默的**（实测 `"集合 {a, b} 非法?"`
  输出 `集合 null 非法?`，不报错；残留的 `` `${x}` `` 会被当作 `$` + 占位符消费）。
  因此新增 `scripts/check-log-migration.ts`（TS AST）纳入 CI，拒绝残留模板插值与
  无对应键的占位符。
- **实测纠正了三处设计假设**（均写入计划 Global Constraints）：LogTape 的级别字符串
  是 `warning` 而非 `warn`；`getLogger` 只接受数组参数（多参数静默忽略）；原生
  `getJsonLinesFormatter()` 形状与既有 JSON 契约不兼容，故 JSON 侧自写 formatter。
- **安全回归被提前拦住**：迁移到消息模板后敏感值会进入 message，字段区脱敏管不到
  它。渲染层因此按占位符名对插值位置**逐值脱敏**（`redactValueByKey`），否则生产环境
  会把完整 `submission_id`/`email` 明文打进消息。
- **已知未修**：JSON 模式下业务字段名为 `msg`/`level`/`ts` 时会覆盖保留字段；模块名
  不做列内对齐；不建设日志聚合平台（继续依赖 `docker logs` 与日志文件）。
```

- [ ] **Step 2: 校验 Agent Note 格式**

```bash
deno run -A scripts/verify-agent-note-format.ts
```

预期：通过。

- [ ] **Step 3: 全仓静态门禁**

```bash
deno run -A scripts/check-ci.ts
```

预期：全部通过，含 `check-log-migration` 与 `check-config-usage`。

- [ ] **Step 4: 四运行时测试全跑**

```bash
cd noj-core && deno task test
```

```bash
cd noj-llm-gateway && deno task test
```

```bash
cd noj-cli && deno task test
```

```bash
cd noj-judge && cargo nextest run --all-targets
```

预期：四者全 PASS。

- [ ] **Step 5: 逐条手工回归（不靠推断）**

| # | 命令 | 期望 | 实际 |
|---|---|---|---|
| 1 | `cd noj-core && deno task dev` | 终端有色 | ☐ |
| 2 | `cd noj-core && deno task dev > /tmp/o.txt 2>&1` | `grep -c $'\x1b\[' /tmp/o.txt` 为 0 | ☐ |
| 3 | `NO_COLOR=1 deno task dev` | 无色 | ☐ |
| 4 | `LOG_COLOR=always deno task dev > /tmp/f` | 有色 | ☐ |
| 5 | `LOG_FORMAT=json deno task dev` | 无转义，`{"ts":...}` 形状 | ☐ |
| 6 | `cd noj-judge && LOG_LEVEL=info timeout 5 cargo run 2>&1 \| cat` | 无转义（缺陷 1 修复） | ☐ |
| 7 | `cd noj-cli && deno run -A src/cli.ts maintain logs --dir <目录> > /tmp/c.txt` | 无转义（缺陷 2 修复） | ☐ |
| 8 | `cd noj-llm-gateway && deno task start > /tmp/gw.txt 2>&1` | 无转义 | ☐ |

把"实际"列填成真实结果，任一条不符则回到对应 Task 修正。

- [ ] **Step 6: 提交收尾**

```bash
jj describe -m "docs(root): 补充统一日志渲染 Agent Note"
jj new
```

---

## 附：任务依赖关系

```
Task 1 (契约文档)
   ↓
Task 2 (log-format.ts)  ← 所有 noj-core 渲染的基础
   ↓
Task 3 (log-config.ts + logging.ts 兼容层)
   ↓
Task 4 (check-log-migration.ts)   ─┐
   ↓                               │ Task 4 的脚本是 Task 5 的验收工具；
Task 5 (core 177 处迁移)  ←────────┘ CI 接线在 Task 5 末尾一并提交
   ↓
Task 6 (judge)  ─┐
Task 7 (gateway) ├─ 三者互不依赖，可并行
Task 8 (cli)    ─┘
   ↓
Task 9 (Agent Note + 全链路验收)
```

**可并行点**：Task 6 / 7 / 8 之间无共享文件，可同时推进。Task 1–5 严格串行。

**风险最高**：Task 5（177 处、86 处跨多行，无法正则批量）。若需压缩范围，优先保留 Task 1–4 与 6–8（契约、渲染层、三个缺陷修复），把 Task 5 按域拆成独立 PR 分批合入——兼容层已保证每个中间态都是绿的。
