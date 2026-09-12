# 统一日志渲染与 LogTape 迁移设计

- Status: proposed
- Date: 2026-09-12
- Scope: noj-core / noj-judge / noj-llm-gateway / noj-cli 的日志呈现层统一；noj-core 全量迁移到 LogTape
- Related: `dev-docs/superpowers/specs/2026-09-10-observability-domain-design.md`（上期明确将日志平台延后）、`dev-docs/engineering/log-conventions.md`（本设计新增）、`noj-core/src/shared/base/logging.ts`

## 1. 背景

`2026-09-10-observability-domain-design.md` 曾明确把日志聚合平台列为非目标，只收敛"日志上下文与结构化字段"，并留下"后续可接外部日志平台，不需要改业务日志调用"的判断。本期是把这句话兑现：统一四个运行时的日志**呈现层**，并把 noj-core 从自研 logger 迁移到成熟库。

四个模块当前的日志实现互不相通：

| 模块 | 现状 | 问题 |
|---|---|---|
| noj-core | 自研零依赖 logger（`shared/base/logging.ts`，290 行）：JSON/pretty 双格式、`LOG_LEVEL`/`LOG_FORMAT`、生产脱敏、ALS 注入 `request_id`、可注入 sink | 全项目最完善的一块，但 pretty 模式无颜色、无视觉层次 |
| noj-judge | `tracing` + `tracing-subscriber::fmt()`，`env-filter` | 输出为人类向文本，字段与 core 对不上；ANSI 未做 TTY 探测 |
| noj-llm-gateway | **无 logger**，仅 4 处裸 `console.log/warn` | 无级别控制、无脱敏、无 `request_id`；已知一处未脱敏泄露 |
| noj-cli | `maintain logs` 读 `docker logs` 或 `run/logs/<component>.log`，`util/color.ts` 提供调色板 | 无条件着色；无聚合与检索 |

### 1.1 顺带修掉的三个既有缺陷

勘察中确认以下缺陷真实存在，本次一并修复：

1. **noj-judge 向结构化日志流灌 ANSI 转义码**。`Cargo.toml` 的 `tracing-subscriber` 未关闭默认 feature，`fmt_layer.rs:743` 的默认推导为
   `let ansi = cfg!(feature = "ansi") && env::var("NO_COLOR").map_or(true, |v| v.is_empty());`
   ——只认 `NO_COLOR`，**不探测 TTY**。而 `docker-compose.prod.yml` 使用 `driver: json-file`，于是转义序列被原样写入日志文件。
2. **`noj-cli logs` 无条件着色**。`maintain/logs.ts` 的 `maintainLogs()` 直接调用 `prefixLine(module, line, colorFor(module))`，无 TTY 探测与 `NO_COLOR` 判断（作者已给 `docker compose logs` 传了 `--no-color`，但漏了自己这一层），`noj-cli logs > out.txt` 会把转义码写入文件。
3. **noj-llm-gateway 未脱敏泄露**。`routes/llm.ts:108` 输出
   `submission=${payload.submission_id} ip=${clientIp}`，明文的提交 ID 与客户端 IP 直接进日志，绕过了全项目"生产日志脱敏"的约定。

### 1.2 关键事实（均已实测，非推断）

本设计的所有技术前提都在本机 Deno 2.9.6 / Rust 1.99 上验证过：

- LogTape 2.3.4（JSR）可在 Deno 下直接运行，无 Node 兼容层。
- `getAnsiColorFormatter()` 支持 `timestamp: "time"`，直接产出契约要求的 `HH:MM:SS.mmm`，无需手写时间格式化。
- `withContext()` 配合 `contextLocalStorage: new AsyncLocalStorage()`（来自 `node:async_hooks`）可**跨 `await` 传播** `request_id`——这是 core 现有 `getRequestId()` 的等价能力。
- `getJsonLinesFormatter()` 产出干净 JSON，含 `request_id` 与全部字段。**但其原生形状与 core 现状不兼容**：原生为 `{"@timestamp","level":"INFO","message","logger","properties":{...}}`（字段**嵌套**在 `properties` 下、级别为**大写全称**、键名为 `@timestamp`/`message`/`logger`），而 core 现状是 `{"ts","level":"info","msg",...,扁平 fields}`。要满足 §2.1 的机读兼容目标，JSON 侧**必须自写 formatter**，不能直接用 `getJsonLinesFormatter()`。`properties: "flatten"` 只能解决嵌套，键名与级别大小写仍需自定义。
- 内置的 `category` 即模块名来源，但**只有数组形式生效**：`getLogger(["noj","submission"])` → category `["noj","submission"]`；而 `getLogger("noj","submission")` 的**第二个参数被静默忽略**，category 仅为 `["noj"]`（`getLogger(category = [])` 只接受单参，多余实参不进函数体）。**必须统一使用数组形式**。
- **LogTape 的级别名是 `warning` 而非 `warn`**：`LogLevel` 为 `trace|debug|info|warning|error|fatal`。配置里写 `lowestLevel: "warn"` 或调用 `parseLogLevel("warn")` 都会**抛 `TypeError: Invalid log level`**（注意：`logger.warn(...)` 这个**方法**名是正确的，只有级别**字符串值**是 `warning`）。core 对外契约仍用 `warn`，需在边界处映射。
- LogTape 的 console sink **同步写出**，进程退出不丢日志（已实测不调用 `dispose()` 亦完整输出）。
- `getAnsiColorFormatter({ format })` 的 `format` 类型是 `(values: FormattedValues) => string`（`formatter.ts:286`），**是函数而非模板字符串**；传字符串会导致 sink 抛 `TypeError: format is not a function`，且失败**静默**（仅记入 meta logger 的 FTL，主输出无任何痕迹）。
- Error 值默认序列化为 `{}`，需自行处理（core 现有行为是渲染 `{name, message, stack}`，属迁移保真项）。
- LogTape 不处理 `NO_COLOR` 或 TTY，着色策略需自行接入。
- LogTape 的 `logger.info(msg, properties)` **签名与 core 现有的 `logger.info(msg, fields)` 兼容**：旧式调用直接可用，JSON 输出完整保留 `properties`，且 Error 默认序列化为 `{name, message, stack}`。
- 但**内置 ansi formatter 不渲染 `properties`**（只输出 message），字段在人读输出中不可见。字段可见性来自**消息模板插值**。
- 模板插值后，被插值的键**仍保留在 `properties` 中**（`"{submission_id}"` + `{submission_id: "abc"}` → message 含 `abc`，且 `properties` 仍含 `submission_id`）。自定义 formatter 若同时渲染 message 与全部 properties，会造成**字段重复**。去重依据可取 `record.rawMessage`（模板原文，类型 `string | TemplateStringsArray`），从中解析出占位符键名并排除。
- 占位符语法比预期宽松：任何 `{...}` 都被当作占位符消费（含 `{a, b}`、`{}`、`{ }`、`{1a}`、`{中文}`、`{a.b}`），缺失键渲染为 `null`。**`{{` 是转义**，`"{{a}}"` 渲染为字面量 `{a}`。实测 noj-core 现状**无一处** message 含字面量花括号（22 处花括号全部来自 JS 模板字符串，即 `${...}` 拼接），因此迁移中不存在“把合法花括号改成 `{{`”的用例，风险集中在“别漏掉 `$`”。
- `record.message` 是**交错数组**（`["入队 ", "abc", " 队列 ", 3, ""]`，长度恒为奇数），不是字符串；拼接需 `.join("")`。`record.rawMessage` 保留未插值的模板原文。
- 未在配置中声明的 category 会**回退到 root logger**（`category: []`）；已声明 category 的**子类别继承**其 `lowestLevel` 与 sinks。
- 默认 `value` 渲染器会给**字符串加双引号并着色**（`"abc"` 带色），与 core 现状（裸值、含空格才加引号）不一致；需自定义 `value`。
- **Error 对象以引用形式保留在 `properties` 中**（`properties.err instanceof Error === true`），但 `JSON.stringify` 得 `{}`（不可枚举）。渲染时必须自行处理：core 现状为 `{name, message, stack}`（开发）/ `{name, message}`（生产）。
- `contextLocalStorage` 可接受裸 `new AsyncLocalStorage()`；`withContext` 无 ALS 配置时**静默不生效**（不抛错），故 ALS 装配遗漏是静默失败面。

### 1.3 规模（精确统计）

noj-core 的迁移面：

| 指标 | 数量 |
|---|---|
| `logger.*` 调用点 | **177**（AST 精确统计；`rg` 计数 179 含 2 处文档注释示例） |
| 涉及文件 | **48** |
| 跨多行调用 | **86** |
| 带字段对象 | **147** |
| msg 为 JS 模板字符串（含 `${}`，迁移必改） | **22** |
| msg 含字面花括号（需 `{{` 转义） | **0** |
| msg 非字面量（变量引用，需人工判断） | **1**（`storage/local.ts:99` 的 `DEPRECATED_WARNING` 常量，实际无花括号） |

**22 处 JS 模板分布**：`shared/mq/base-consumer.ts` 11、`main.ts` 5、`domains/submission/mq/sweeper.ts` 3、`domains/catalog/services/problems/problem-bundle.ts` 1、`problem-field-guard.ts` 1、`shared/db/connection.ts` 1。

**147 处带字段对象的调用需要逐一判断**：LogTape 下字段若已插值进 message，会在 pretty 输出中被去重（见 §3.2），因此"哪些字段提升进 message、哪些留在字段区"是每处都要做的呈现决策，而非机械替换。

noj-judge：`info!/warn!/error!/debug!` 调用点 **96** 处，其中 **50** 处已使用 tracing 结构化字段语法（`warn!(user_id = %user_id, "...")`），字段级对齐无需重写调用点。

**86 处跨多行意味着迁移无法用正则批量完成**，必须借助 TS AST 或逐处人工——这直接决定实施计划的工作量。

## 2. 目标与非目标

### 2.1 目标

- 建立一份跨运行时的**日志视觉契约**（`dev-docs/engineering/log-conventions.md`），定义颜色语义、单行布局与着色判定顺序，四个模块共同遵守。
- noj-core 全量迁移到 **LogTape 2.3.4**，采用原生风格：每模块 `getLogger(["noj", "<module>"])` + 消息模板插值。
- noj-judge 继续使用 **`tracing` + `tracing-subscriber`**，通过自定义 `FormatEvent` 实现同一套布局与配色。
- noj-llm-gateway 引入 LogTape 建立 logger，补齐级别控制、脱敏、`request_id` 上下文。
- noj-cli 接入同一套着色策略，修复无条件着色。
- 统一着色判定：`NO_COLOR` → `LOG_COLOR` → TTY 探测，且 `LOG_FORMAT=json` 时恒无色。
- 修复 §1.1 的三个既有缺陷。
- 保持机读输出（JSON 模式）的字段语义与现状兼容。

### 2.2 非目标

- 不引入 OpenTelemetry SDK 或分布式追踪后端；仅保留 `request_id` 上下文。
- 不建设日志聚合平台（Loki/ELK）；继续依赖 `docker logs` 与日志文件。
- 不改动日志的**调用时机、级别、内容语义**；本次是呈现层与库迁移，不新增或删除日志调用点。
- 不引入 banner/card 等多行渲染原语；启动横幅维持单行（见 §7）。
- 不改动 `JSON` 模式下保留字段与业务字段的覆盖关系（已知问题，见 §7）。
- 不为 noj-judge 引入除 `tracing` 生态外的日志库（Rust 侧无 LogTape/pino 的对应物）。

## 3. 视觉契约

契约的单一事实源为 `dev-docs/engineering/log-conventions.md`，以下为其内容摘要。

### 3.1 颜色语义

| 语义 | SGR | 应用位置 |
|---|---|---|
| ERROR | `1;31` 粗体红 | 级别徽章 + 整行粗体 |
| WARN | `1;33` 粗体黄 | 级别徽章 + 整行粗体 |
| INFO | `36` 青 | 级别徽章 |
| DEBUG | `90` 亮黑（灰） | 级别徽章 |
| dim | `2` | 时间戳、字段名、`=`、`rid` |

**明确不使用 24-bit 真彩品牌色**：（a）品牌亮色 `#1B2B4A` 在深色终端对比度极低、几乎不可见，可用的暗色 `#7C96D6` 需 24-bit 支持；（b）24-bit 在 CI、老版本 tmux/screen、部分 Windows 终端会被降级或产生乱码。日志跨环境高频输出，兼容性与可预期性优先于品牌表现；品牌色留在 UI 与文档站（`dev-docs/design/noj-design-tokens.md` 的辖区）。

### 3.2 单行布局

```
14:32:07.412  INFO   评测任务入队  rid=550e8400  submission_id=550e8400...  queue_length=3
└── dim ────┘  └级别色┘ └──msg──┘  └─ dim ──┘  └ key dim · = dim · value 默认色 ┘
```

- 时间戳 `HH:MM:SS.mmm`，固定 12 字符，dim。**不使用方括号**（定宽已足够分列，方括号是纯视觉噪声）。
- 级别 `padEnd(5)` 定宽（`INFO ` / `WARN ` / `ERROR` / `DEBUG`）着色；WARN/ERROR 整行额外粗体。
- `rid` 为 `request_id` 前 8 字符，dim（沿用现状截断策略）。
- 字段：`key` dim、`=` dim、`value` 默认色；字段间两空格。
- 字段**不排序**（对象字面量顺序天然稳定，排序收益低于可预测性）。
- msg 含换行时，后续行按 msg 列缩进，避免列结构被冲垮。

**字段去重规则（LogTape 特有，保真关键）**：LogTape 在模板插值后仍将被插值的键保留在 `properties` 中。因此 formatter 渲染字段区时**必须排除已插值进 message 的键**，否则同一字段会出现两次（message 内一次、字段区一次），破坏 core 现有"msg + 字段平铺、每个字段只出现一次"的输出形状。未被模板提及的键照常输出。

例：`logger.info("入队 {submission_id}", { submission_id: "abc", queue_length: 3 })`

```
14:32:07.412  INFO   入队 abc  queue_length=3
                     ↑ submission_id 已插值，字段区不再重复
```

### 3.3 着色判定顺序

四个运行时使用同一套判定：

```
NO_COLOR 已设且非空   → 关
LOG_COLOR=never      → 关
LOG_COLOR=always     → 开
LOG_COLOR=auto/未设   → 按流探测 TTY
```

两条硬规则：

1. **按流分别探测**。`warn`/`error` 走 stderr，`info`/`debug` 走 stdout。TS 侧用 `Deno.stdout.isTerminal()` / `Deno.stderr.isTerminal()` 分别判断；Rust 侧对 `stdout()`/`stderr()` 分别使用 `std::io::IsTerminal`（Rust 1.70+ 稳定，本机 1.99 满足）。
2. **`LOG_FORMAT=json` 时恒无色，`LOG_COLOR` 被忽略**。此规则优先于一切着色开关，专门防止 §1.1 缺陷 1 复发。

`LOG_COLOR` 非法值按 `auto` 处理并 warn 一次，不致命。

### 3.4 模块名

LogTape 的 `category` 天然提供模块名（`getLogger(["noj", "<module>"])`）。每模块的 category 取该文件所属域或 shared 子目录名（如 `submission`、`identity`、`db`、`sse`），根文件（`main.ts`/`app.ts`）取 `core`。

noj-judge 侧使用 tracing 的 `target` 作为等价物。

模块名的**列内对齐**不在本期范围（多行布局与列宽调整属 §7 的延期项）；本期仅保证 category 进入输出。

## 4. 各模块设计

### 4.1 noj-core

- 新增 `src/shared/base/log-config.ts`：LogTape 配置装配（sinks、formatters、级别过滤、`contextLocalStorage`）与着色策略 `resolveColor(stream)`。
- 改造 `src/shared/base/logging.ts`：
  - 保留 `redactId`、生产脱敏规则表与 `LogRecord` 类型作为迁移期兼容面。
  - 保留 `setLogSink`/`resetLogSink` 测试接口，使现有 8 个测试**零改动**通过（它们全部断言 `LogRecord` 对象，不断言字符串）。
  - 以 LogTape formatter 实现 pretty 与 JSON 两种输出，Error 序列化保持 `{name, message, stack}`（开发）/ `{name, message}`（生产）。
- 48 个文件、177 处调用点迁移到 `getLogger(["noj", "<module>"])` + 消息模板：
  ```ts
  // 迁移前
  logger.info("评测任务入队", { submission_id, queue_length });
  // 迁移后
  logger.info("评测任务入队 {submission_id} 队列 {queue_length}", { submission_id, queue_length });
  ```
- 登记 `LOG_COLOR` 至 `shared/config/settings-registry.ts` 的日志段（`LOG_LEVEL`/`LOG_FORMAT` 已存在，照其形态）并同步 `.env.example`。

### 4.2 noj-judge

- 新增 `src/logging.rs`：自定义 `FormatEvent` 实现 §3 布局与配色，自带 SGR 常量。
- `main.rs` 的 `tracing_subscriber::fmt()` 初始化改为装配自定义 formatter，并按 §3.3 接入 `LOG_COLOR`/TTY 判定。
- 输出分流：warn/error 走 stderr，info/debug 走 stdout（与 core 一致）。tracing 默认 writer 是 `io::stdout`（`fmt_layer.rs:739` 的 `make_writer: io::stdout`），需自定义 `MakeWriter` 实现按级别分流。
- 级别映射：`RUST_LOG` **优先**（保留现有 per-target 调试能力），未设置时回退读取 `LOG_LEVEL` 并转换为过滤指令。注意 `EnvFilter` 解析的是过滤指令语法（`info,noj_judge=debug`），非裸级别。
- Error/字段渲染沿用 tracing 的结构化字段，保证 50 处已结构化的调用点自动获得字段级着色。

### 4.3 noj-llm-gateway

现状为零基础设施（无 `NOJ_ENV`、无 `request_id`、无 ALS、`app.ts` 无中间件），需新建：

- `src/logger.ts`：LogTape 装配，级别/格式/着色策略与 core 同构。
- `src/context.ts` + `app.ts` 中间件：ALS `request_id`，生成或透传 `X-Request-Id`。
- 替换 4 处裸 `console` 调用为 logger（`routes/llm.ts` 1 处 + `db/seed.ts`/`db/migrate.ts`/`db/migrate-cli.ts` 各 1 处），并修复 §1.1 缺陷 3。
- 脱敏规则：复用 core 的敏感键集合（`password`/`token`/`secret`/`code`/`email`/`authorization`/`cookie`/`jwt`）+ `*_id` 截断 + `score` 隐藏，并补齐网关特有敏感键（`api_key`、`encrypted_api_key`、`eval_token`、`service_token`、`store_key`）。
- 配置登记：`LOG_COLOR`、以及网关开始读取的 `LOG_LEVEL`/`LOG_FORMAT` 需在 `src/config-registry.ts` 声明并同步 `noj-llm-gateway/.env.example` 与根 `.env.prod.example`。
  **已确认可行**：`noj-core/scripts/check-config-usage.ts`（issue #500 引入，父提交 `6d93a1f9`）实施的双向校验遵循 issue #497 的「谁读谁声明」原则，判定方式是**键名字面量出现在消费文件中**，而非要求单一登记方。因此同一键在 core 注册表与网关声明中各出现一次是允许的，前提是两侧都有真实读取点——网关侧的读取点即 `src/logger.ts`。该脚本已接入 CI，故此项由 CI 机械保证，无需人工约定。

### 4.4 noj-cli

- `src/util/color.ts`：新增 `resolveColor()` 实现 §3.3；`prefixLine` 接受启用标志。
- `src/maintain/logs.ts`：接入策略，修复 §1.1 缺陷 2；新增 `--color=auto|always|never`。
- 调色板与 §3.1 对齐（现为 8 色 FNV-1a 稳定取色，保留取色逻辑，色值对齐契约）。

## 5. 迁移风险与对策

### 5.1 头号风险：msg 花括号语法冲突（静默失败）

LogTape 的消息模板把 `{...}` 解析为占位符。经实测：

```ts
log.info("集合 {a, b} 非法?", {})
// 实际输出：集合 null 非法?    ← 不报错、不抛异常
log.info("缺失 {missing}", {})
// 实际输出：缺失 null
```

而 noj-core 有 **22 处** msg 是 JS 模板字符串（`${...}`），分布在 `shared/mq/base-consumer.ts`（11）、`main.ts`（5）、`domains/submission/mq/sweeper.ts`（3）、`domains/catalog/services/problems/problem-bundle.ts`（1）、`problem-field-guard.ts`（1）、`shared/db/connection.ts`（1）。迁移时必须把

```ts
logger.info(`${label}消费者正在启动...`)
```

改写为

```ts
logger.info("{label}消费者正在启动...", { label })
```

若机械替换或遗漏，`${label}` 会连同 `$` 一起被当作占位符消费（`"${a}"` → `"$" + null`），**且不产生任何错误**。

**另需注意字面花括号**：实测 noj-core 现状**无一处** msg 含字面量 `{`/`}`，故本期不存在"把合法花括号转义为 `{{`"的迁移用例；但该风险随新代码引入而长存，校验脚本须一并覆盖（`{{` 是合法转义，单独的 `{` 会被吞）。

**对策**：新增静态校验 `scripts/check-log-migration.ts`，基于 TS AST 扫描全部 `logger.*` / `getLogger(...).*` 调用：

- 拒绝 msg 参数中残留的 JS 模板插值（`` `${` ``）；
- 拒绝 msg 中未被对应 properties 满足的裸花括号占位符；
- 每个占位符必须在同一调用的 properties 中有对应键。

该校验纳入 CI，作为迁移完整性的机械保证。

### 5.2 86 处跨多行调用

近半数调用点跨多行，正则无法安全重写。迁移须用 TS AST 变换或逐处人工，并在每个阶段以 §6 的验证矩阵确认。

### 5.3 LogTape 静默失败面

`getAnsiColorFormatter({ format })` 传错类型会**静默丢日志**（仅 meta logger 记 FTL）。对策：显式配置 meta logger 为独立 sink 并保持 `error` 级别以上可见，且为 formatter 补单测，锁住"传入函数"的约定。

### 5.4 测试兼容

`tests/shared/logging_test.ts` 的 8 个测试通过 `setLogSink` 捕获 `LogRecord` 对象断言，未断言 pretty 字符串，且 `defaultSink` 未导出；全仓库无脚本解析 pretty 输出。因此布局变更**测试安全**。

但需明确两点，避免误判"零改动"：

- 该测试文件内的 `logger.info("测试消息", { foo: "bar" })` **本身也是调用点**，随 §4.1 一并迁移（属 177 处之内），断言目标 `LogRecord`/`fields` 的语义保持不变。
- 其余 6 个引用 `base/logging.ts` 的文件（`tests/shared/email-providers.test.ts`、`domains/identity/tests/**`、`domains/submission/**`、`domains/contest/services/contest-anti-cheat.ts`）同属迁移面，逐一确认断言不受影响。

真正的兼容保证是：`setLogSink`/`resetLogSink`/`LogRecord`/`redactId` 的导出与语义保持不变，使**测试断言的对象形状**不因底层换库而改变。

## 6. 验证

### 6.1 测试矩阵

| 代码库 | 命令 | 覆盖 |
|---|---|---|
| noj-core | `deno task test` | 新增 formatter 单测（无色/有色、级别对齐、字段着色、多行缩进）、`resolveColor` 全分支；现有 8 个 logging 测试零改动通过 |
| noj-core | `deno task check:env` | `LOG_COLOR` 登记与 `.env.example` 一致性 |
| noj-core | `deno task check:config-usage` | 声明 ↔ 读取点双向校验（core 侧 `LOG_COLOR`/`LOG_LEVEL`/`LOG_FORMAT` 有读取点；网关侧三键有读取点） |
| noj-judge | `cargo nextest run --all-targets`、`cargo clippy`、`cargo fmt` | `FormatEvent` 布局、`LOG_LEVEL` 映射（`RUST_LOG` 优先）、分流 |
| noj-llm-gateway | `deno task check`、`deno task test` | logger 级别/脱敏/上下文；`config_registry_test.ts` 枚举 |
| noj-cli | `deno task check`、`deno task test` | `resolveColor`、`--color` 解析 |
| 全仓 | `scripts/check-log-migration.ts` | §5.1 的模板语法正确性 |

### 6.2 手工回归（逐条实测，不靠推断）

```bash
deno task dev                       # 应有色
deno task dev > /tmp/o.txt 2>&1     # 必须无色
NO_COLOR=1 deno task dev            # 必须无色
LOG_COLOR=always deno task dev > f  # 必须有色
LOG_FORMAT=json deno task dev       # 必须无色，且字段与今日兼容
cargo run 2>&1 | cat                # judge：转义码必须消失（修复缺陷 1）
noj-cli logs > /tmp/c.txt           # cli：转义码必须消失（修复缺陷 2）
```

## 7. 已知问题与延期项

- **JSON 保留字段覆盖**：现有 JSON 分支为 `${...record.fields}` 扁平展开，业务字段若名为 `msg`/`level`/`ts` 会覆盖保留字段。修它需改动 JSON 输出形状，超出本期范围，**记录不修**。
- **多行渲染原语（banner/card）**：启动横幅与评测事件卡片未纳入本期；启动横幅维持单行，关键事件的突出程度上限为 warn/error 整行粗体。
- **模块名列内对齐**：见 §3.4。
- **日志聚合平台**：不做。

## 8. 交付物

```
dev-docs/engineering/log-conventions.md            新增（跨语言视觉契约）
scripts/check-log-migration.ts                     新增（模板语法校验）
noj-core/src/shared/base/log-config.ts             新增
noj-core/src/shared/base/logging.ts                改造（兼容层 + LogTape formatter）
noj-core/src/shared/config/settings-registry.ts    登记 LOG_COLOR
noj-core/.env.example                              同步
noj-core/src/**（48 文件 / 177 调用点）             迁移到 getLogger + 消息模板
noj-judge/src/logging.rs                           新增（FormatEvent + MakeWriter）
noj-judge/src/main.rs                              装配
noj-llm-gateway/src/logger.ts                      新增
noj-llm-gateway/src/context.ts                     新增（ALS request_id）
noj-llm-gateway/src/app.ts                         挂中间件
noj-llm-gateway/src/routes/llm.ts                  1 处 console → logger，修未脱敏泄露
noj-llm-gateway/src/db/{seed,migrate,migrate-cli}.ts 其余 3 处 console → logger
noj-llm-gateway/src/config-registry.ts             登记
noj-llm-gateway/.env.example / .env.prod.example   同步
noj-cli/src/util/color.ts / src/maintain/logs.ts   着色策略
```

## 9. 实施顺序

分阶段，每阶段可独立验收：

1. **契约与公共层**：`log-conventions.md`、`check-log-migration.ts`、core 的 `log-config.ts` 与兼容层。
2. **noj-core 迁移**：48 文件 / 177 调用点。
3. **noj-judge**：`FormatEvent` + 分流 + 级别映射 + 修复缺陷 1。
4. **noj-llm-gateway**：新建 logger + 上下文 + 脱敏 + 修复缺陷 3。
5. **noj-cli**：着色策略 + 修复缺陷 2。

提交按模块拆分（`feat(core)` / `feat(judge)` / `feat(gateway)` / `feat(root)`），全部 GPG 签名。Agent Note 落 `.agents/notes/implemented/architecture/2026-09-12-unified-log-rendering-conventions.md`。

## 10. 备选方案

- **pino**：在 Deno 下实测可用，且 `@pinojs/redact` 提供内置脱敏。未选用原因：Node 库，需 `--node-modules-dir`，并引入原生模块（`sonic-boom`/`thread-stream`），在 Deno 运行时中属长期负债；且无 ALS 上下文与 category 等价能力。
- **OpenTelemetry logs**：API 在 Deno 下可用，但 SDK 未验证，且需自备人读 formatter 与脱敏；对本期"呈现层统一"的目标过重。
- **继续自研渲染层**：不引入依赖，但需手写时间格式化、级别过滤、跨运行时一致性维护，且无法获得 ALS 上下文与 category 的既有实现。
- **保留自研 API、内部换 LogTape**：改动面最小（仅改内部），但无法获得 category 模块名、`withContext` 与专用 sink 等完整能力。已明确选择全量迁移。
