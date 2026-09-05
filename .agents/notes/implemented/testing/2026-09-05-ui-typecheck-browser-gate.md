# Agent Note: UI 全页面类型检查 + 浏览器关键流程门禁 + Fork PR 数据库测试（#427 / #430）

Status: implemented

## Problem

两个上线准备评估发现（基线 `de6fd665`）：

- **#427**：`check:types` 只覆盖 `utils tests`，UI CI 只跑构建与工具函数测试；
  注册页 `register.vue` 的 `sent` 变量作用域错误（`const sent` 声明在第一个
  `try` 块内、在第二个 `try` 块中引用）没有任何检查能拦截。浏览器侧的关键
  用户流程（注册验证、登录退出、代码提交到结果、核心失败反馈）完全无门禁；
  且 e2e.yml 的 `paths-ignore` 排除了 `noj-ui/**`，UI 改动不触发 E2E。
- **#430**：`core-test-db` 依赖仓库 Secret `JWT_SECRET`，Fork / Dependabot PR
  拿不到 Secret 只能 `SKIPPED_NO_SECRETS` 跳过，开源 PR 失去数据库回归保障。

## Decision

**#427**

1. 修复 `register.vue` 的 `sent` 作用域 bug（提升到 `handleRegister` 顶层声明）。
2. 新增 `noj-ui` task `check:types:nuxt`：`nuxt typecheck`（负责生成 .nuxt
   类型上下文）+ 显式 `vue-tsc --noEmit`（负责检查）。两个 Nuxt CLI 命令在
   Deno（nodeModulesDir auto）下各有缺陷，实测：
   - `nuxt prepare` 的类型生成静默缺失（`.nuxt/tsconfig.json` 等不会生成，
     vue-tsc 退回默认编译选项，CI 上报出数千个假错误）；
   - `nuxt typecheck` 内部启动的 vue-tsc 会静默跳过（故意还原 bug 仍退出 0），
     但类型生成正常。
   因此拆为「typecheck 生成 + 显式 vue-tsc 检查」两步，缺一不可。
3. `noj-ui/tsconfig.json` 排除 `tests/`：Deno 测试由既有 `deno check` 负责，
   不属于 Nuxt 类型上下文。
4. 清零存量 244 个类型错误（56 文件），全部为最小类型修复，不改运行行为：
   - `contests` 的 `Conversation`/`Participant`/`MessageHistoryItem` 补后端
     实际返回的字段（`other_user_avatar_url` / `avatar_url` / `conversation_id`）；
   - `useToast` 的 `timeout` → `duration`（Nuxt UI v4 改名，原配置运行时无效）、
     Modal `:ui.width` → `:ui.content`、`color="gray|white|red"` →
     `neutral|error`（v4 合法值）；
   - 多个页面误把 `@nuxt/ui` 自动导入的同名 `useToast` 当项目 composable，
     补显式 `import { useToast } from '~/composables/useToast'`；
   - `useFetch` 的死配置 `silent: true`（Nuxt 无此选项）删除以恢复响应类型推断；
     可空 URL 的 `computed` getter 以 `as unknown as Ref<...>` 断言（Nuxt
     `UseFetch` 类型不接受 null，运行时支持）；
   - `noUncheckedIndexedAccess` 下标访问守卫、`Record` 索引可选链、UTable
     `columns` 补 `TableColumn<行类型>` 标注消除 cell `info` 隐式 any；
   - `useApi` 的 `useRequestFetch` 断言为 `typeof $fetch`（全量路由表类型推导
     超出 TS 递归上限 TS2321）。
5. 新增 `noj-tests/e2e/browser/ui_flows.test.ts`（task `test:browser`，
   guard `NOJ_RUN_BROWSER_E2E=1`）：Playwright 驱动 4 条关键路径，失败自动
   落盘 trace + 截图到 `test-results/ui-browser/`。
6. CI：`ci.yml` ui-check 增加「全页面类型检查」步骤；`e2e.yml` 移除
   `noj-ui/**` 忽略并在 API E2E 之后增加「UI 浏览器关键流程门禁」步骤
   （构建 noj-ui → 启动 Nitro server → 缓存并安装 Playwright Chromium →
   `deno task test:browser` → 失败上传诊断产物）。

**#430**

`core-test-db` 的 JWT_SECRET 改为在 step 内注入：仓库 Secret 存在时校验长度
后使用；缺失（Fork / Dependabot）时 `openssl rand -hex 32` 生成仅本次运行有效
的一次性随机密钥。本 job 只依赖服务容器内的 PostgreSQL / Redis（凭据固定
noj/noj），不触及真实外部服务，因此 Fork PR 可执行同等的数据库集成测试；
真正需要外部凭据的专用测试（S3 / SMTP 等）不在本 job 清单内，按各自环境
变量 guard 单独跳过。新增 step summary 区分 `JWT_SECRET_SOURCE`
（repo-secret / random-per-run）并明确记录「实际执行」而非跳过。

## Alternatives considered

- `nuxt typecheck`：实测在 Deno 下静默不执行 vue-tsc，弃用。
- 一次性修复全部 244 个错误不如分批：但门禁必须全绿才能合入，且均为机械
  修复，风险可控，一次完成。
- 浏览器门禁放 ci.yml 独立 job：需要重建整个评测栈（judge / DB / MinIO），
  放 e2e.yml 复用既有栈成本低得多。
- 浏览器驱动选 puppeteer-core + 系统 Chrome：Playwright 的 trace/截图诊断
  产物生态更完整，且支持 `playwright install chromium` 缓存。
- #430 维持跳过 + 文档说明：跳过会继续降低开源 PR 验证质量（issue 明确否定）。

## Consequences

- `noj-ui` 的 `deno task check` 现在包含 vue-tsc 全页面检查（本地耗时
  ~1-3 min）；后续新增页面/组件必须类型正确才能过 CI。
- UI 改动会触发 e2e.yml 全栈 workflow（此前被忽略），UI PR 的 CI 时长增加
  约 5-10 min，换来关键用户流程的真实浏览器回归。
- `noj-tests/deno.lock` 新增 playwright 依赖；CI 用 GHA cache 缓存浏览器二进制。
- Fork PR 的 core-test-db 每次生成随机 JWT_SECRET，只存在于该 job 环境；
  测试失败仍使 job 失败（不再有静默跳过路径）。
- `pages/contests` 的 `is_objective` 在后端 `ContestProblemResponse` 中缺失
  （竞赛客观题分支运行时恒为 false），本次仅在 UI 类型上以可选字段如实标注，
  后端补齐是独立事项。
