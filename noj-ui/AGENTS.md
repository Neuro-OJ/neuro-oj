# noj-ui — Neuro OJ 核心前端

Nuxt 4 + Vue 3 + Nuxt UI v4 前端（Deno 2
开发/构建）。本文只放**禁令、验证命令、文档路由**；
目录、组件、样式、数据获取、安全等细节全部在 `docs/`。

## 1 禁令

- **禁止直接 `$fetch`**：业务代码统一 `useApi()`（例外仅 Nitro 代理与
  `composables/useApi.ts` 自身）；错误文案用
  `extractApiError(e).message`，不手写 `e.data?.error || e.status`。→
  [data.md](docs/data.md)
- **禁止用正则净化服务端富文本**：必须复用 `utils/sanitize-policy.ts`
  的政策；净化失败 一律降级纯文本（fail-closed），不得输出未净化 HTML。→
  [security.md](docs/security.md)
- **禁止把 `ssr: false` 写进 `definePageMeta`**：开关只放 `nuxt.config.ts` 的
  `routeRules`， 页面清单在 `utils/ssr-routes.ts`；非关键数据 SSR
  失败必须降级为空态，不得整页 502。 → [data.md](docs/data.md)
- **禁止手写通用组件、禁止手写布局 CSS**：通用组件用 Nuxt UI `U*` （UButton /
  UInput / UModal / UTable / UBadge …），布局与排版用 Tailwind utility；
  主题只改 `assets/css/main.css` 与 `app.vue`。→ [styling.md](docs/styling.md)
- **禁止未签名提交、禁止直推 `main` 与 rc 集成分支**：一律主题分支 +
  PR；提交信息 `feat(ui): 中文描述` / `fix(ui): 中文描述`。GPG 与分支流程见根
  [AGENTS.md](../AGENTS.md) 禁令 1–2 与
  [workflow.md](../dev-docs/agents/workflow.md)。
- 其余红线（`deno.lock`、`.env`、生产库 schema、`_journal.json`）见根
  [AGENTS.md](../AGENTS.md) 禁令 3–5 与
  [conventions.md](../dev-docs/agents/conventions.md)。

## 2 命令

```bash
deno task dev              # 开发：HMR + API 代理
deno task check            # 提交前必过：fmt --check + lint + 类型（含 vue-tsc）
deno task test             # Deno 单测：server/ 代理、composable、净化
deno task test:components  # vitest 组件测试
deno task build            # SSR 构建 → .output/
deno task compile          # 单二进制 → dist/noj-ui（标志见 build.md）
deno task preview          # 预览构建产物
deno fmt / deno lint       # 单独格式化 / 检查

deno task test:theme       # 编辑器主题浏览器回归（先起 UI）
deno task test:bff:ssr     # 真实 Chromium：首屏 / 点击 / 水合
```

浏览器类任务首次先装
Chromium：`deno run -A npm:playwright@1.65.1 install chromium`； `test:theme` 需
`E2E_UI_URL=http://127.0.0.1:3000`。改 Vue 页面后另跑
`deno fmt --unstable-component`。编译与运行方式见 [build.md](docs/build.md)。

## 3 路由

| 要查什么                                           | 去哪                                                            |
| -------------------------------------------------- | --------------------------------------------------------------- |
| 目录职责、组件分组、关键组件                       | [structure.md](docs/structure.md)                               |
| composable 语义与易踩点（useAuth / useSearch …）   | [composables.md](docs/composables.md)                           |
| 数据获取策略、SSR 约定、`ssr:false` 清单、路由守卫 | [data.md](docs/data.md)                                         |
| JWT / Cookie、Nitro 代理、富文本净化、密码重置页   | [security.md](docs/security.md)                                 |
| Nuxt UI / Tailwind 用法、主题色表、品牌 token      | [styling.md](docs/styling.md)                                   |
| 单二进制编译、环境变量                             | [build.md](docs/build.md)                                       |
| 视图 BFF 接口、缓存与 SSR 验收                     | [bff.md](docs/bff.md)                                           |
| 工作空间（多域）前端                               | [workspace.md](docs/workspace.md)                               |
| 文案表与 API 错误文案                              | [i18n.md](docs/i18n.md)                                         |
| 设计 token 全表                                    | [noj-design-tokens.md](../dev-docs/design/noj-design-tokens.md) |
| 提交签名、分支与 PR 流程                           | [workflow.md](../dev-docs/agents/workflow.md)                   |
| 编码规范、安全基线、品牌 token 总表                | [conventions.md](../dev-docs/agents/conventions.md)             |

高频入口：`composables/useApi.ts`、`utils/sanitize-policy.ts`、`utils/ssr-routes.ts`、
`server/api/[...slug].ts`、`assets/css/main.css`、`app.vue`。
