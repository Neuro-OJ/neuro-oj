# 编码、安全与品牌约定

> 根 [`AGENTS.md`](../../AGENTS.md) 的 conventions 落点：编码规范、多副本约束、
> 安全基线、品牌与设计 Token。提交流程见 [`workflow.md`](./workflow.md)。

## 1. 编码规范

- TypeScript/Deno：`deno fmt` + `deno lint`（`noj-core`、`noj-llm-gateway`、`noj-cli`
  由 CI 强制）；Rust：`cargo fmt` + `cargo clippy`（由 CI 强制）；Vue：提交前在
  `noj-ui/` 内跑 `deno task check`（含 `deno fmt --check`、`deno lint` 与类型检查）。
- **缩进统一 2 空格**：TS / Vue / JSON / YAML / Markdown 列表都用 2 格；Rust 由
  `cargo fmt` 保证 4 格。各模块 `deno.json` 的 `fmt.indentWidth` 已固定为 2（`noj-ui`
  未显式写，取 Deno 默认 2），**不要再改成 4**。2026-11 曾尝试全仓改 4 格（2,100+
  文件），因与并行开发持续冲突而被回滚（#776 合入后 #784 撤回）。
- **禁止在仓库根目录直接跑全仓 `deno fmt`**：格式化必须在各模块目录下按各自
  `deno.json` 执行。根目录没有统一的 `deno.json`，直接跑会用 Deno 默认配置
  （`singleQuote: false`、`lineWidth: 80`）覆盖 `noj-ui` 的 `singleQuote: true` /
  `lineWidth: 120` 并重排全仓文档与夹具，产生夹带大量无关改动的 diff；若要调整
  全仓或根目录格式化门禁，应单独立项评审。
- 中文注释 + 英文标识符。
- Deno 错误用 `AppError` 继承体系；Rust 用 `anyhow::Result`。
- 日志生产环境自动脱敏，不得直接输出敏感字段。

## 2. 多副本约束

- 业务事实、额度、限流及需跨副本一致的状态一律走 Redis/DB。
- 只读、可容忍短暂不一致的数据可放有界且带 TTL 的进程内缓存；新增缓存必须在
  [`dev-docs/engineering/domain-boundaries.md`](../engineering/domain-boundaries.md#多副本约束2026-09-12-架构评审-26)
  登记 TTL 与多副本后果。
- 其余进程内可变状态必须登记为「单副本专用」。
- **配置失效必须「重新加载」而非仅 `cache.delete()`**：`getSetting()` 缓存未命中
  不回查 DB，只删缓存会读到 env/default 而非真实新值。

## 3. 安全基线

安全模型见 [security.md](../../noj-docs/docs/system/security.md) 与
[defensive-patterns.md](../engineering/defensive-patterns.md)。关键规则：

| 面         | 要求                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| 认证       | JWT HS256，HTTP-only Cookie，24h 过期                                                            |
| 口令       | bcrypt cost 12，最小 8 位且含大小写字母与数字                                                    |
| 评测容器   | `cap_drop ALL`、`no-new-privileges`、`network_mode none`、`ipc_mode none`、`pids_limit 256`      |
| ZIP 压缩包 | 拒绝路径穿越；≤1000 条目 / 64MiB 单文件 / 512MiB 总解压                                          |
| 日志与审计 | 业务 ID 与 score 保留；code/token/secret/password 等及 DB 密码脱敏；审计日志保留 90 天（可配置） |

## 4. 品牌与设计系统

所有前端与文档站颜色、圆角必须遵循
[`dev-docs/design/noj-design-tokens.md`](../design/noj-design-tokens.md)。

| 角色         | 亮色                        | 暗色                        | 用途                                 |
| ------------ | --------------------------- | --------------------------- | ------------------------------------ |
| 品牌天青蓝   | `#0369a1`（Sky 700）        | `#38bdf8`（Sky 400）        | 高亮链接、关键按钮、激活项、品牌交互 |
| 工作台表面   | `#f7f8fa`（底）/ `#ffffff`  | `#0b1120`（底）/ `#111827`  | 页底、面板、编辑器独立暗色工作区     |
| 评测信号绿   | `#047857`（Emerald 700）    | `#00e07a`                   | 评测状态、提交通过、运行就绪         |

- 正文可用 `#0f172a`（Slate 900）；严格 3 档近直角圆角：4px / 6px（默认） / 10px。
- 数值文本用 `tabular-nums`。
- 修改品牌 token 时必须同步更新
  `noj-ui/app.vue`、`noj-ui/assets/css/main.css`、`noj-docs` 主题与
  [`dev-docs/design/noj-design-tokens.md`](../design/noj-design-tokens.md)（颜色值的
  唯一来源；根 `AGENTS.md` 已不含具体色值）。

## 5. 搜索与本地工具

- 搜索代码/文件内容必须使用 `rg`（ripgrep），不要使用 `grep`；仅当环境中不存在
  `rg` 时才允许回退。
- AI 工具配置、编辑器配置、临时日志、备份文件等本地产物不得提交。
