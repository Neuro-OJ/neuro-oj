# noj-ui — Neuro OJ 核心前端

基于 **Nuxt 4 + Vue 3** 的用户界面。

## 职责

- 用户注册、登录、个人中心
- 题目列表与题目详情展示
- 代码编辑器（提交代码）
- 评测结果展示（实时 / 历史）
- 通过 RESTful API 与 noj-core 交互（Nitro 代理）

## 技术栈

| 组件         | 选择                                             |
| ------------ | ------------------------------------------------ |
| 框架         | Nuxt 4 (Vue 3)                                   |
| 语言         | TypeScript                                       |
| 样式         | Tailwind CSS                                     |
| 代码编辑器   | Monaco Editor                                    |
| 运行时       | Deno 2（开发/构建） / 单二进制 `deno compile`（部署） |
| 图标         | @lucide/vue                                      |
| Markdown     | markdown-it + highlight.js + KaTeX + DOMPurify    |

## 目录结构

```
noj-ui/
├── deno.json              # 任务定义 + npm 兼容配置
├── nuxt.config.ts         # Nuxt 配置（vite、nitro preset、runtimeConfig、hooks）
├── package.json
├── tailwind.config.ts     # Tailwind 主题扩展（含 prose-neuro 排版插件）
├── app.vue                # 根组件 + CSS 变量定义
├── pages/                 # 文件路由（Nuxt 自动路由）
│   ├── index.vue          # 首页（Hero）
│   ├── login.vue / register.vue
│   ├── problems.vue       # 题目列表
│   ├── problems/[id].vue  # 题目详情 + 代码提交
│   ├── submissions/       # 提交历史
│   ├── admin/             # 管理后台（管理员，ssr: false）
│   └── ...
├── components/            # 可复用 Vue 组件
│   ├── Navbar.vue         # 导航栏
│   ├── Footer.vue         # 页脚
│   ├── ProblemFilterBar.vue  # 题目筛选栏
│   ├── ProblemEditor.vue  # 题目编辑器（管理后台）
│   ├── MarkdownRenderer.vue  # Markdown 渲染（DOMPurify 清洗）
│   ├── MonacoEditor.vue   # 代码编辑器（CDN 加载 Monaco）
│   ├── SubmissionTable.vue   # 提交历史表格
│   ├── ui/                # 通用 UI 组件
│   │   ├── BaseButton.vue
│   │   ├── AsyncContent.vue
│   │   ├── DataTable.vue
│   │   └── ...
├── composables/           # 组合式函数
│   ├── useAuth.ts         # 认证状态管理
│   ├── usePolling.ts      # 轮询工具
│   ├── useToast.ts        # Toast 通知（SweetAlert2）
│   ├── useDialog.ts       # 弹窗（SweetAlert2）
│   ├── useProblemFilters.ts  # 题目筛选 URL 同步
│   └── use-submissions.ts # 提交历史数据获取
├── layouts/               # 页面布局
│   ├── default.vue        # 默认布局（导航栏 + 页脚）
│   ├── auth.vue           # 认证页面布局（登录/注册）
│   └── admin.vue          # 管理后台布局（侧边栏 + 顶栏）
├── server/                # Nitro 服务端 API（代理到 noj-core）
│   └── api/
│       ├── [...slug].ts   # 通用代理 + Cookie 管理
│       └── auth/logout.post.ts  # 注销端点（本地清除 Cookie）
├── middleware/             # Nuxt 路由守卫
│   ├── auth.ts            # 登录守卫（5s 超时）
│   └── admin.ts           # 管理员守卫（静默重定向）
├── utils/                 # 工具函数（sanitize HTML）
├── assets/                # 静态资源（logo.jpg 等）
└── .output/               # 构建产物（gitignored）
    ├── server/            # SSR 服务端代码
    ├── public/            # 客户端静态资源
    └── deno.json          # Nitro 生成的启动配置
```

## Nuxt 配置要点（nuxt.config.ts）

```typescript
// @lucide/vue 的 SSR 兼容：强制 Vite 打包入 SSR bundle
vite: {
  ssr: { noExternal: ["@lucide/vue"] },
  optimizeDeps: { include: ["@lucide/vue"] },
}

// Nitro 部署预设（Deno compile 需要）
nitro: { preset: "deno-server" }

// 编译后 hooks.close 防止进程 hang
hooks: { close: () => process.exit(0) }
```

## 开发命令

```bash
# 开发模式（HMR + API 代理）
deno task dev

# 构建 SSR（输出到 .output/）
deno task build

# 编译单二进制（build + deno compile）
deno task compile          # 输出 dist/noj-ui

# 预览构建结果
deno task preview

# 代码检查 / 格式化
deno task lint
deno task fmt
```

## 编译单二进制（`deno task compile`）

完整流程和关键标志：

```bash
# 等价于依次执行：
nuxt build                                    # 构建 SSR + 客户端
mkdir -p dist
deno compile -A --no-check \
  --unstable-byonm \                          # 启用 CJS npm 包解析
  --unstable-node-globals \                   # 提供 process/Buffer 等全局变量
  --include .output/public \                  # 嵌入客户端静态资源（否则 404）
  --output dist/noj-ui \                      # 输出路径
  .output/server/index.mjs                    # 入口文件
```

**运行编译产物**：
```bash
cd dist
./noj-ui
# 默认监听 http://localhost:3000
```

> **为什么需要 `--unstable-byonm`**：Nuxt Nitro 输出依赖大量 CJS npm 包（Vue 编译器、highlight.js 等）。Deno 默认的 npm 解析方式无法正确处理这些包的 `require()` 调用。`--unstable-byonm`（Bring Your Own Node Modules）让 Deno 使用原生 `node_modules` 目录结构解析 CJS 包。
>
> **为什么需要 `--include .output/public`**：`deno compile` 默认只打包入口模块及其依赖，不包含客户端静态资源（JS/CSS/字体等）。没有此标志启动后所有 `/_nuxt/*` 请求返回 404。
>
> **`hooks.close`**：`nuxt.config.ts` 中的 `close: () => process.exit(0)` 防止 Nitro 关闭时 Deno 进程 hang 住。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NUXT_API_BASE` | `http://localhost:8000` | noj-core API 地址（服务端私有） |

## API 交互约定

- 所有 API 请求通过 `server/api/[...slug].ts` **Nitro 代理**转发到 noj-core
- 代理负责：
  - 拦截登录响应，将 JWT 设为 **HTTP-only Cookie**（`noj:token`）—— 对 JS 不可见
  - 设置 **可读 Session Cookie**（`noj:session`）—— 存用户基本信息，仅用于 UI 快速判断登录态
  - 自动从 Cookie 注入 `Authorization: Bearer` 头到转发请求
- 注销：`server/api/auth/logout.post.ts` 删除两个 Cookie（**纯本地操作**，不调用后端 API）

### 代理实现细节（[...slug].ts）

- **仅拦截** `POST /api/v1/auth/login`：解析登录响应，提取 JWT 设置 Cookie，从响应体删除 `token` 字段
- **不拦截**注册等其他认证端点
- 非登录请求：从 Cookie 读取 `noj:token`，注入 `Authorization: Bearer` 头后直接 `proxyRequest()`
- 错误处理：`$fetch.raw` 抛出的 `err.response` 被捕获并原样转发状态码和 body
- **无 URL 校验**：所有路径直接拼接 `apiBase + event.path`，无白名单过滤

### 安全模型

| 机制 | 说明 |
|------|------|
| JWT 存储 | HTTP-only Cookie（`noj:token`），JS 不可读，防 XSS 窃取 |
| Session Cookie | `noj:session`，`httpOnly: false`，仅用于 UI 快速判断登录态（**不可信任**，后端执行实际鉴权） |
| CSRF 防护 | `sameSite: "lax"` 提供基础防护 |
| 速率限制 | **未实现**（无 IP 封禁 / CAPTCHA） |
| 错误信息 | 后端错误信息直接显示给用户（`e.data?.error`） |
| 管理路由 | `/admin/*` 路径在客户端 bundle 中可见，非管理员静默重定向到 `/` |

## 样式规范

- **必须使用 Tailwind CSS 编写，禁止手写 CSS**
- 组件模板中直接使用 Tailwind utility 类

```
例：class="flex items-center gap-2 p-4"
```

- 复杂或复用的样式组合使用 `@apply` 封装在 `<style>` 中
- 全局主题定制（颜色、字体、阴影）统一在 `tailwind.config.ts` 的 `theme.extend` 中配置
- CSS 变量（`--c-*`）仅在 `app.vue:root` 和 `tailwind.config.ts` 中定义
- Vue Transition（`<Transition name="...">`）、`::before`/`::after` 伪元素、`@keyframes` 可保留 `<style>` 块

## 可用 Tailwind 主题色

| 类名前缀 | 对应 CSS 变量 |
|----------|---------------|
| `primary` / `primary-dark` / `primary-light` | `--c-primary*` |
| `primary-bg` / `primary-hover-bg` / `primary-active-bg` / `primary-text` | `--c-primary-*` |
| `text` / `text-secondary` / `text-muted` | `--c-text-*` |
| `border` / `bg-page` / `white` | `--c-border` / `--c-bg-page` / `--c-white` |
| `bg-dark` / `bg-dark-2` / `bg-dark-3` | `--c-bg-dark*` |
| `success-text` / `info-text` / `warning-text` / `error-text` | `--c-*-text` |
| `font-mono` | SF Mono / Fira Code / Consolas |
| `animate-spin-slow` | spin 0.8s（0.8s 一圈） |
| `shadow-card` / `shadow-dropdown` / `shadow-modal` | 预定义阴影 |

### Tailwind 扩展配置

| 配置项 | 值 |
|--------|-----|
| 圆角 | `sm: 4px` / `DEFAULT: 6px` / `md: 8px` / `lg: 12px` / `xl: 16px` |
| 过渡时长 | `fast: 150ms` / `DEFAULT: 200ms` / `slow: 300ms` |
| 排版插件 | `prose-neuro` 类（自定义代码块/表格/引用样式） |
| 字体栈 | `SF Mono → Fira Code → Consolas → monospace`（无中文字体指定） |

## 组件结构

- 使用 `<script setup lang="ts">` Composition API
- 组件命名：PascalCase（`MyComponent.vue`）
- 页面文件：kebab-case，按资源组织
- 全局状态通过 `useState()` 共享（如 `useAuth` 的 `auth:user`）
- API 调用封装在 `composables/` 中
- 类型定义放在组件内或 `composables/` 中（无单独 `types/` 目录）
- SweetAlert2 用于弹窗（`useDialog`）和 Toast 通知（`useToast`）

## Composables 参考

### useAuth
- `useState<AuthUser | null>("auth:user")` 存储用户信息（含 `must_change_password` 字段，issue #75）
- `fetchUser()`：调用 `/api/v1/auth/me`，401 时自动调用 `logout()` 清除状态
- `login(credentials)` / `register(data)` / `logout()`：封装对应 API 调用
- `changePassword(oldPassword, newPassword)`：调用 `/api/v1/auth/change-password`，成功后自动 `logout()` 清 Cookie 并跳 `/login?reason=password_changed`（避免旧 JWT flag 残留致路由守卫死循环）
- `logout()` 清除 `auth:user` 状态 + 调用 `/api/auth/logout` 删除 Cookie
- 初始化时若 Cookie 存在则自动调用 `fetchUser()`（SSR 阶段跳过）

### usePolling
- `usePolling(fn, interval, immediate?)`：基于 `setInterval` 的轮询工具
- 组件卸载时自动清理（`onUnmounted`）
- 静默处理错误（catch 块为空，不向用户显示错误）
- 使用请求 ID 模式防止竞态（旧响应的处理被跳过）

### useToast
- 基于 SweetAlert2 的 Toast 通知
- `showToast(type, title)`：`success` / `error` / `info` / `warning`
- 自动消失（timer: 3000ms），无确认按钮
- SSR 安全（`process.client` 守卫）

### useDialog
- 基于 SweetAlert2 的确认弹窗
- `showConfirm(title, text, danger?)`：返回 Promise<boolean>
- `danger: true` 时显示红色确认按钮（删除操作）
- SSR 安全

### useProblemFilters
- URL 驱动的题目筛选（`useRoute().query` 同步）
- 筛选条件变化时自动重置页码
- 防抖处理（避免快速输入时频繁请求）

### use-submissions
- `useSubmissions()`：获取提交历史列表
- `useSubmissionDetail(id)`：获取单个提交详情（含轮询 pending 状态）
- 分值格式化：`score / 100`（数据库存储 ×100）
- 状态/颜色映射：`Accepted→green`、`WrongAnswer→red`、`TimeLimitExceeded→yellow` 等

## 数据获取策略

| 场景 | 方法 | 说明 |
|------|------|------|
| 页面初始数据 | `useAsyncData` + `$fetch` | SSR 时在服务端获取，水合时复用 |
| 客户端 API 调用 | `$fetch` | 通过 Nitro 代理转发 |
| 轮询 | `usePolling` composable | 基于 `setInterval`，组件卸载自动清理 |
| 表单提交 | `$fetch` + 手动错误处理 | 显示后端返回的错误信息 |

## 中间件

### auth 守卫
- 检查 `noj:session` Cookie 是否存在
- 不存在 → `navigateTo("/login")`
- 存在但需要验证 → 调用 `fetchUser()`，5 秒超时
- SSR 阶段跳过守卫，客户端水合后重新执行
- **强制改密（issue #75）**：`user.must_change_password=true` 时强制跳 `/change-password`（白名单路径 `/change-password`、`/login`、`/logout` 放行）

### admin 守卫
- 检查 `noj:session` Cookie 中的 `role` 字段
- 非管理员 → `navigateTo("/")`（静默重定向，无错误提示）
- SSR 阶段跳过

### ssr: false 页面
- 所有 `/admin/*` 页面
- 原因：管理后台依赖客户端状态，SSR 无意义且可能暴露敏感数据

## 关键组件说明

| 组件 | 说明 |
|------|------|
| `MonacoEditor.vue` | 通过 CDN 加载 Monaco Editor（非 npm 包），`diff` 模式可选 |
| `MarkdownRenderer.vue` | markdown-it + highlight.js + KaTeX 渲染，**DOMPurify 清洗 HTML** 防 XSS |
| `ProblemEditor.vue` | 管理后台题目编辑器，支持 U/P 类型切换，必填字段校验 |
| `DataTable.vue` | 通用数据表格，支持排序、分页、空状态、加载态 |
| `BaseButton.vue` | 通用按钮，支持 `loading`、`disabled`、`to`（NuxtLink） |
| `AsyncContent.vue` | 异步内容容器，统一处理 loading / empty / error 状态 |
| `SubmissionTable.vue` | 提交历史表格，状态标签着色，点击跳转详情 |

## 认证守卫

| 中间件 | 路径 | 行为 |
|--------|------|------|
| `auth` | 所有需登录页面 | 未登录 → `/login` |
| `admin` | `/admin/*` | 未登录 → `/login`，非管理员 → `/`（静默拦截） |

> SSR 阶段跳过守卫，客户端水合后重新执行。所有 admin 页面使用 `ssr: false`。

## 密码重置页面（issue #49）

| 页面 | 路径 | 用途 |
|------|------|------|
| 忘记密码 | `/forgot-password` | 步骤 1：输入注册邮箱 → 显示"邮件已发送"绿色 banner |
| 重置密码 | `/reset-password` | 步骤 2：URL `?token=...` → 输入新密码 + 确认密码 → 跳 `/login?reset=1` |

**实现约定**：

- 两页使用 `definePageMeta({ layout: "auth" })`，与 login/register 布局一致
- 完全仿 `login.vue` / `register.vue` 模式：Lucide 图标 + Tailwind utility 类 + Transition banner
- `useAuth()` 暴露 `forgotPassword(email)` + `resetPassword(token, newPassword)` 两个方法
- `middleware/auth.ts` 顶部 `PUBLIC_AUTH_PATHS` 白名单含 `/forgot-password` + `/reset-password`
- 错误状态：复用现有 `setError` + 3000ms 自动消失模式（重置页用 5000ms 给用户更多时间）
- 成功状态：重置成功后跳 `/login?reset=1`，login.vue 读 `route.query.reset === "1"` 显示"密码重置成功"绿色 banner

**安全约束**：

- 前端**不**判断邮箱是否存在（服务端防枚举：统一返 200 + 同一消息）
- token 仅从 URL `?token=...` 读取，提交时透传给后端
- 不在前端打印、缓存或上报 token

## 已知限制

- **无单元测试 / E2E 测试**：项目未配置测试框架
- **无 SEO 优化**：无 Open Graph 标签、结构化数据、sitemap
- **无图片优化**：仅 `logo.jpg`，未使用 Nuxt 图片优化
- **无字体优化**：使用系统字体栈，无 web font 加载
- **Composable 命名不一致**：部分使用 camelCase（`useAuth`），部分使用 kebab-case（`use-submissions`）

## 贡献要求

- **所有提交必须 GPG 签名**（详见根目录 README.md）
- **所有代码必须通过 PR 提交**，禁止直接推送到 main
- 提交信息格式：`feat(ui): 中文描述` / `fix(ui): 中文描述`

## 相关文档

- [Nuxt 4 文档](https://nuxt.com/docs)
- [Vue 3 文档](https://vuejs.org/)
- [Tailwind CSS](https://tailwindcss.com/)
- [Monaco Editor](https://microsoft.github.io/monaco-editor/)
