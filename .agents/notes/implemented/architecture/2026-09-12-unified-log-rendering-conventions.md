# Agent Note: 统一日志渲染与 LogTape 迁移

Status: implemented

## Problem

四个运行时（noj-core / noj-judge / noj-llm-gateway / noj-cli）的日志呈现互不相通：
core 的自研 logger pretty 模式无颜色、judge 的 tracing 布局与 core 对不上、gateway
只有裸 `console` 调用、cli 无条件着色。勘察确认三个既有缺陷：

1. judge 向 `driver: json-file` 日志流灌 ANSI 转义码（`tracing-subscriber` 默认 ansi
   推导只认 `NO_COLOR`，不探测 TTY）；
2. `noj-cli logs > out.txt` 写入转义码（`maintainLogs` 无条件调 `prefixLine`）；
3. `gateway/routes/llm.ts` 明文输出 `submission_id` 与客户端 IP，绕过生产脱敏约定。

## Decision

- 建立跨运行时**视觉契约** `dev-docs/engineering/log-conventions.md`（SGR 语义、单行
  布局、着色判定顺序、脱敏不变量），作为单一事实源。
- noj-core 全量迁移到 **LogTape 2.3.4**（JSR），采用原生风格：
  `getLogger(["noj", "<module>"])` + 消息模板插值。48 文件 / 177 处调用点。
- `shared/base/logging.ts` 降级为**兼容层**：导出形状（`LogRecord`/`setLogSink`/
  `resetLogSink`/`redactId`）与语义不变，内部换 LogTape，使既有断言测试零改动通过。
- judge 继续用 `tracing` + `tracing-subscriber`，自写 `FormatEvent` 实现同一布局，
  `MakeWriter::make_writer_for` 按级别分流；着色**按流分别探测**。
- 着色判定统一为 `NO_COLOR` → `LOG_COLOR`/`--color` → TTY，且 `LOG_FORMAT=json`
  恒无色（该规则优先于一切开关，专门防止缺陷 1 复发）。
- 字段去重（LogTape 插值键仍留在 `properties`）只发生在**呈现层**，不改变
  `LogRecord.fields`，以保住既有测试断言。
- 脱敏规则**单一实现**：`redactFields` 逐值委托 `redactValueByKey`，不在两处各写一份。

## Alternatives considered

- **pino**：Deno 下可用且有 `@pinojs/redact`，但属 Node 库，需 `--node-modules-dir`
  并引入原生模块（`sonic-boom`/`thread-stream`），且无 ALS 上下文与 category 等价能力。
- **OpenTelemetry logs**：API 可用但 SDK 未验证，且需自备人读 formatter 与脱敏，
  对"呈现层统一"的目标过重。
- **保留自研 API、内部换 LogTape**：改动面最小，但拿不到 category 模块名、
  `withContext` 与专用 sink 等完整能力。已明确选择全量迁移。
- **给 judge 补 JSON 输出与脱敏**：契约 §4/§6 写的是跨运行时要求，但 judge 是纯
  worker、输出只进 `docker logs`，补一套 Rust 侧脱敏属范围外。**改为显式声明边界**
  （见 Consequences），而非留一个「契约要求但无实现」的悬空承诺。
- **judge 用 `1>file 2>tty` 时取 `stdout || stderr` 的单一布尔**：实现更简单，
  但会把转义码写进被重定向的文件——正是本次要修的缺陷类。故按流分别判定。

## Consequences

- **静态校验成为必需**：LogTape 的占位符失败是**静默的**（实测 `"集合 {a, b} 非法?"`
  输出 `集合 null 非法?`，不报错；残留的 `` `${x}` `` 会被当作 `$` + 占位符消费）。
  因此新增 `scripts/check-log-migration.ts`（TS AST）纳入 CI，拒绝残留模板插值与
  无对应键的占位符。其扫描范围是 **noj-core/src 与 noj-llm-gateway/src**，
  不覆盖 Rust / noj-cli / noj-ui——文档中不使用「全仓」措辞以免高估覆盖面。
- **实测纠正了三处设计假设**：LogTape 的级别字符串是 `warning` 而非 `warn`；
  `getLogger` 只接受数组参数（多参数静默忽略）；原生 `getJsonLinesFormatter()`
  形状与既有 JSON 契约不兼容，故 JSON 侧自写 formatter。
- **安全回归被提前拦住**：迁移到消息模板后敏感值会进入 message，字段区脱敏管不到
  它。渲染层因此按占位符名对插值位置**逐值脱敏**（`redactValueByKey`）。
- **request_id 传播必须共用同一 ALS 实例且键名为 `request_id`**：LogTape 的
  `contextLocalStorage` 会把 store 的全部键并入 `properties`，而 formatter 只认契约
  键名。两套 ALS 实例或 camelCase 键名都会让 `properties.request_id` 恒为 undefined，
  且**不会让任何测试变红**（兼容层曾手工注入该键，掩盖了缺陷）。
- **`request_id` 是 `*_id` 通配脱敏的显式例外**：它由服务端随机生成、不携带用户
  隐私，唯一用途是跨服务串联；被截断成前 8 字符即失去用途。pretty 侧仍按契约 §1
  自行取前 8 字符控制展示长度。
- **`NOJ_ENV` 必须显式注入 gateway 容器**：网关的 JSON 输出与全部脱敏都以
  `NOJ_ENV=production` 为开关，而 compose 的 `x-core-env` 锚点只作用于 core。
  缺失时网关按开发模式运行——彩色 pretty 写进 json-file 且敏感字段不脱敏。
- **judge 的日志边界**：只读取 `LOG_LEVEL` / `LOG_COLOR` / `NO_COLOR`，输出契约化
  pretty 文本；**不实现** JSON 输出与 §6 脱敏。契约 §4/§6 的适用运行时为
  core / gateway，compose 不为 judge 注入 `NOJ_ENV`/`LOG_FORMAT` 以免产生无读取点
  的误导配置。
- **保留键冲突已有确定行为**：业务字段名为 `msg`/`level`/`ts`/`request_id` 时改名为
  `field_<name>` 保留，不覆盖 JSON 信封。此前该冲突会静默抹掉消息体本身。
- **明确不在本期能力内**：模块名不做列内对齐；不建设日志聚合平台（依赖
  `docker logs` 与日志文件）。
