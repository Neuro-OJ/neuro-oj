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

`LOG_COLOR` 非法值按 `auto` 处理，不致命（不额外告警）。`NO_COLOR=""`（空串）不算设置。
`LOG_COLOR` 值大小写不敏感并去除首尾空白，三个运行时行为一致。

## 4. 机器可读输出（JSON）

`LOG_FORMAT=json` 时输出**保持与既有形状兼容**：

```json
{"ts":"2026-09-12T05:11:45.689Z","level":"info","msg":"入队 abc","submission_id":"abc","queue_length":3}
```

- `ts` ISO 8601、`level` 小写契约名（`debug|info|warn|error`）、`msg` 渲染后文本。
- `request_id` 存在时才出现，**保留完整值**（关联标识，见 §6）。
- 其余字段**平铺**在顶层。
- **恒无 ANSI 转义序列。**
- 业务字段名为保留键（`ts`/`level`/`msg`/`request_id`）时改名为 `field_<name>`
  保留，不覆盖信封——否则一条 `logger.info("x", { msg })` 会静默抹掉消息体。

**适用范围**：§4 与 §6 由 **noj-core / noj-llm-gateway**（及 noj-cli 的着色策略）
实现。noj-judge 是纯 worker，只输出契约化 pretty 文本，读取 `LOG_LEVEL` /
`LOG_COLOR` / `NO_COLOR`，不实现 JSON 与脱敏——其日志仅进 `docker logs`。

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
| **例外：不脱敏** | `request_id`（关联标识，非业务实体 id） |

- **`request_id` 是 `*_id` 通配规则的显式例外**：它由服务端随机生成、不携带用户
  隐私，唯一用途是跨服务串联同一次请求；截断成前 8 字符即失去用途。pretty 侧仍按
  §2 自行取前 8 字符控制展示长度。
- **嵌套结构递归脱敏**：顶层键名匹配不到嵌套对象/数组里的 `password`/`api_key` 等，
  故对非敏感键的值递归下探（深度上限 6，防自引用）。

开发/测试环境不脱敏（便于本地调试）；Error 保留 `stack`，生产仅 `{name, message}`。

> **网关特有**：`client_ip` / `ip` / `ips` 在生产环境整值抹除（隐私最小化）。
