# NOJ React 前端迁移实施草案

日期：2026-10-24。状态：第一批 React 基础与练习核心流程已实现；其余页面待迁移。

## 目标与边界

将 `noj-ui` 的 Nuxt/Vue 用户界面迁移到 React，并统一使用 React UI 库。 后端
`noj-core`、评测服务 `noj-judge`、LLM 网关、IDE 插件和 CLI 的业务职责不变。 现有
URL、API 契约、权限规则、题目版本绑定与部署能力是迁移验收基线。

当前仓库包含 **72 个 Vue 页面、99 个 Vue
组件**。页面清单见下文；有路由并不代表该页面完成迁移，必须逐项验证读写流程。

## 推荐技术方案

| 层次       | 推荐选择                                  | 目的                                             |
| ---------- | ----------------------------------------- | ------------------------------------------------ |
| 页面框架   | React + TypeScript                        | 替换 Vue 页面及组件                              |
| 路由与渲染 | React Router Framework Mode + Vite        | 统一嵌套路由、数据加载、SSR 与客户端导航         |
| UI 库      | shadcn/ui                                 | 已选定：表单、表格、抽屉、对话框、通知与管理界面 |
| 主题       | shadcn/ui 语义变量 + 既有 NOJ token       | 保留天青蓝、信号绿、近直角与数值等宽排版         |
| 服务端     | Deno 上的 Web Request/Response 适配层     | 保留同源认证代理、流式转发和编译部署能力         |
| 编辑器     | 现有 Monaco 依赖的 React 封装             | 自托管资源、worker、生命周期清理、草稿与主题     |
| 内容渲染   | 既有 markdown-it / KaTeX / DOMPurify      | 保留数学公式、代码高亮和 XSS 清洗                |
| 测试       | Deno 业务单测 + React 组件测试 + 现有 E2E | 将旧行为转成迁移验收契约                         |

依赖版本在实际安装时核对并通过包管理器生成锁文件。不得手动修改 `deno.lock`。

参考官方文档：[React 项目创建](https://react.dev/learn/creating-a-react-app)、
[React Router 框架入口](https://reactrouter.com/tutorials/quickstart)、
[shadcn/ui 组件](https://ui.shadcn.com/docs/components)、
[shadcn/ui 安装](https://ui.shadcn.com/docs/installation/manual)。

## 必须保持的行为

1. **认证边界**：JWT 仅进入 HttpOnly `noj:token` Cookie。登录与改密响应剥离
   token；支持 query 参数的路径判定、记住我、TFA、OAuth
   跳转、注销、强制改密和法律政策同意。
2. **服务端代理**：先规范化再验证 `/api/v1/`
   白名单，拒绝编码路径穿越，保留上游状态码、限流头、OAuth 重定向与
   Set-Cookie，SSE 使用流式 Response。客户端 IP 必须包含真实 TCP 对端。
3. **渲染隔离**：题面、比赛介绍、公告等内容页保持
   SSR；用户会话与请求数据按请求创建，禁止进程级共享可变状态；管理、编辑器等页面保持合适的客户端边界。
4. **评测契约**：题目草稿与不可变版本、提交绑定版本、有效成绩策略、竞赛固定版本及乐观锁字段按现有
   API 回传。分数按存储值除以 100 展示，保留当前状态命名。
5. **作答模式**：客观题、代码题、OI、产物、prediction、提示词和界面题分别验证。保留自测、上传限制、沙箱
   iframe、LLM 模型别名与评测状态更新。
6. **交互与内容**：URL
   筛选、分页、返回路径、错误详情、加载/空/失败状态、移动端操作、键盘导航和中英文能力逐项验证，禁止使用占位按钮代替原功能。
7. **品牌**：使用 `dev-docs/design/noj-design-tokens.md`；通用组件交给选定的
   React UI 库，避免重复建设。

## 实施批次及验收

### 1. React 运行链路与公共能力

建立独立可构建的 React 入口、路由、主题、统一 API 错误处理和认证上下文。 将现有
Nitro 代理行为抽成或迁为可测试的 Web 标准处理器，逐项验证
Cookie、安全响应头、路径白名单、重定向、SSE 与请求取消。
首批用首页、登录和题库验证从浏览器到后端的真实链路，并验证内容页 SSR
数据及水合。

### 2. 题库、编辑器与提交

迁移题目筛选与详情、全部作答模式、Monaco、草稿、出题/改题/题包导入、提交列表与结果详情。
对题目版本切换、赛时固定版本、上传失败重试和实时评测更新建立回归用例。

### 3. 竞赛、训练与社交

迁移报名、密码赛、比赛题面、排行榜及冻结规则、答疑、训练计划、社区、通知和私信。
验证内容审核、禁言、赛时静默、引用/转发/编辑/撤回、未读数和访问权限。

### 4. 管理后台与账户设置

使用 UI
库表格、表单、抽屉和确认框迁移后台领域；保留权限控制、敏感字段保护与审计行为。
迁移个人设置、两步验证、OAuth 关联、密码与邮箱流程、头像、政策同意及账号删除。
不得用通用 JSON 编辑器替代已有业务表单。

### 5. 工程切换与清理

更新 `deno task`、CI、Dockerfile、Deno
单二进制产物、Compose、版本信息、站点地图、安全头与模块文档。 验证
`deno compile` 嵌入客户端和 Monaco 静态资源，并执行生产产物烟测。
全部页面验收后移除 Nuxt/Vue 依赖和旧目录，补充 implemented Agent
Note，再提交草稿 PR 并等待 CI。

每批次的最低门禁：格式、lint、类型检查、相关业务与组件测试、构建、桌面/手机浏览器验收。
集成测试使用仓库规定的 `deno task`；跨域流程使用 `noj-tests` 规定的 domain
任务。

## 已确认的迁移策略

- **分批迁移**：先交付可运行的 React
  基础与核心流程，旧页面在各批次验收前继续提供服务；需要明确迁移期间的路由归属与回退入口。
- **独立分支完整迁移**：全部页面与工程链路通过验收后统一替换；期间主线继续使用现有
  Nuxt 前端。

用户已确认 **全部前端使用 shadcn/ui，分批迁移，先完成 React 基础与核心流程**。

第一批通过 `/react` 提供独立路由。当前复用 Nuxt SSR 与既有 Nitro 认证代理，React
Router 使用库模式；React 运行时代码独立于
Vue。后续完成其余领域后再评估移除过渡适配与默认路由切换。 实现与验证命令见
[React 迁移说明](../../../noj-ui/react/README.md)。

下表标记第一批已有对应 React
入口的页面；题目详情中的客观题和界面题作答仍转入原专用页面。

## 页面验收清单

### 认证与账号（8 页）

| 路由               | 当前源码                                              | 状态   |
| ------------------ | ----------------------------------------------------- | ------ |
| `/change-password` | [现有实现](../../../noj-ui/pages/change-password.vue) | 待迁移 |
| `/forgot-password` | [现有实现](../../../noj-ui/pages/forgot-password.vue) | 待迁移 |
| `/login`           | [现有实现](../../../noj-ui/pages/login.vue)           | 待迁移 |
| `/register`        | [现有实现](../../../noj-ui/pages/register.vue)        | 待迁移 |
| `/reset-password`  | [现有实现](../../../noj-ui/pages/reset-password.vue)  | 待迁移 |
| `/set-password`    | [现有实现](../../../noj-ui/pages/set-password.vue)    | 待迁移 |
| `/settings`        | [现有实现](../../../noj-ui/pages/settings.vue)        | 待迁移 |
| `/verify-email`    | [现有实现](../../../noj-ui/pages/verify-email.vue)    | 待迁移 |

### 公开内容与导航（11 页）

| 路由                  | 当前源码                                                  | 状态   |
| --------------------- | --------------------------------------------------------- | ------ |
| `/about`              | [现有实现](../../../noj-ui/pages/about.vue)               | 待迁移 |
| `/announcements/[id]` | [现有实现](../../../noj-ui/pages/announcements/[id].vue)  | 待迁移 |
| `/announcements`      | [现有实现](../../../noj-ui/pages/announcements/index.vue) | 待迁移 |
| `/data-policy`        | [现有实现](../../../noj-ui/pages/data-policy.vue)         | 待迁移 |
| `/`                   | [现有实现](../../../noj-ui/pages/index.vue)               | 待迁移 |
| `/legal/privacy`      | [现有实现](../../../noj-ui/pages/legal/privacy.vue)       | 待迁移 |
| `/legal/terms`        | [现有实现](../../../noj-ui/pages/legal/terms.vue)         | 待迁移 |
| `/queue`              | [现有实现](../../../noj-ui/pages/queue.vue)               | 待迁移 |
| `/ranking`            | [现有实现](../../../noj-ui/pages/ranking.vue)             | 待迁移 |
| `/search`             | [现有实现](../../../noj-ui/pages/search.vue)              | 待迁移 |
| `/users/[id]`         | [现有实现](../../../noj-ui/pages/users/[id].vue)          | 待迁移 |

### 题库与出题（9 页）

| 路由                      | 当前源码                                                     | 状态   |
| ------------------------- | ------------------------------------------------------------ | ------ |
| `/my/problems`            | [现有实现](../../../noj-ui/pages/my/problems.vue)            | 待迁移 |
| `/problems/[id]/edit`     | [现有实现](../../../noj-ui/pages/problems/[id]/edit.vue)     | 待迁移 |
| `/problems/[id]`          | [现有实现](../../../noj-ui/pages/problems/[id].vue)          | 待迁移 |
| `/problems/new/bundle`    | [现有实现](../../../noj-ui/pages/problems/new/bundle.vue)    | 待迁移 |
| `/problems/new/coding`    | [现有实现](../../../noj-ui/pages/problems/new/coding.vue)    | 待迁移 |
| `/problems/new`           | [现有实现](../../../noj-ui/pages/problems/new/index.vue)     | 待迁移 |
| `/problems/new/objective` | [现有实现](../../../noj-ui/pages/problems/new/objective.vue) | 待迁移 |
| `/problems/new/oi`        | [现有实现](../../../noj-ui/pages/problems/new/oi.vue)        | 待迁移 |
| `/problems`               | [现有实现](../../../noj-ui/pages/problems.vue)               | 待迁移 |

### 作答与提交（3 页）

| 路由                | 当前源码                                                | 状态                  |
| ------------------- | ------------------------------------------------------- | --------------------- |
| `/editor/[id]`      | [现有实现](../../../noj-ui/pages/editor/[id].vue)       | 待迁移                |
| `/submissions/[id]` | [现有实现](../../../noj-ui/pages/submissions/[id].vue)  | 待迁移                |
| `/submissions`      | [现有实现](../../../noj-ui/pages/submissions/index.vue) | 第一批已有 React 入口 |

### 竞赛与训练（7 页）

| 路由                                     | 当前源码                                                                    | 状态   |
| ---------------------------------------- | --------------------------------------------------------------------------- | ------ |
| `/contests/[contestId]`                  | [现有实现](../../../noj-ui/pages/contests/[contestId]/index.vue)            | 待迁移 |
| `/contests/[contestId]/problems/[label]` | [现有实现](../../../noj-ui/pages/contests/[contestId]/problems/[label].vue) | 待迁移 |
| `/contests/[contestId]/ranking`          | [现有实现](../../../noj-ui/pages/contests/[contestId]/ranking.vue)          | 待迁移 |
| `/contests`                              | [现有实现](../../../noj-ui/pages/contests/index.vue)                        | 待迁移 |
| `/trainings/[id]`                        | [现有实现](../../../noj-ui/pages/trainings/[id].vue)                        | 待迁移 |
| `/trainings`                             | [现有实现](../../../noj-ui/pages/trainings/index.vue)                       | 待迁移 |
| `/trainings/mine`                        | [现有实现](../../../noj-ui/pages/trainings/mine.vue)                        | 待迁移 |

### 社区与私信（7 页）

| 路由                            | 当前源码                                                            | 状态   |
| ------------------------------- | ------------------------------------------------------------------- | ------ |
| `/community/bookmarks`          | [现有实现](../../../noj-ui/pages/community/bookmarks.vue)           | 待迁移 |
| `/community`                    | [现有实现](../../../noj-ui/pages/community/index.vue)               | 待迁移 |
| `/community/notifications/[id]` | [现有实现](../../../noj-ui/pages/community/notifications/[id].vue)  | 待迁移 |
| `/community/notifications`      | [现有实现](../../../noj-ui/pages/community/notifications/index.vue) | 待迁移 |
| `/community/posts/[postId]`     | [现有实现](../../../noj-ui/pages/community/posts/[postId].vue)      | 待迁移 |
| `/community/reports/[id]`       | [现有实现](../../../noj-ui/pages/community/reports/[id].vue)        | 待迁移 |
| `/messages`                     | [现有实现](../../../noj-ui/pages/messages/index.vue)                | 待迁移 |

### 管理后台（27 页）

| 路由                       | 当前源码                                                      | 状态   |
| -------------------------- | ------------------------------------------------------------- | ------ |
| `/admin/announcements`     | [现有实现](../../../noj-ui/pages/admin/announcements.vue)     | 待迁移 |
| `/admin/audit-logs`        | [现有实现](../../../noj-ui/pages/admin/audit-logs.vue)        | 待迁移 |
| `/admin/blacklist`         | [现有实现](../../../noj-ui/pages/admin/blacklist.vue)         | 待迁移 |
| `/admin/carousel`          | [现有实现](../../../noj-ui/pages/admin/carousel.vue)          | 待迁移 |
| `/admin/community`         | [现有实现](../../../noj-ui/pages/admin/community.vue)         | 待迁移 |
| `/admin/content-review`    | [现有实现](../../../noj-ui/pages/admin/content-review.vue)    | 待迁移 |
| `/admin/contests`          | [现有实现](../../../noj-ui/pages/admin/contests.vue)          | 待迁移 |
| `/admin`                   | [现有实现](../../../noj-ui/pages/admin/index.vue)             | 待迁移 |
| `/admin/judge-images`      | [现有实现](../../../noj-ui/pages/admin/judge-images.vue)      | 待迁移 |
| `/admin/legal`             | [现有实现](../../../noj-ui/pages/admin/legal.vue)             | 待迁移 |
| `/admin/llm/providers`     | [现有实现](../../../noj-ui/pages/admin/llm/providers.vue)     | 待迁移 |
| `/admin/llm/quotas`        | [现有实现](../../../noj-ui/pages/admin/llm/quotas.vue)        | 待迁移 |
| `/admin/llm/usage`         | [现有实现](../../../noj-ui/pages/admin/llm/usage.vue)         | 待迁移 |
| `/admin/problem-edit/[id]` | [现有实现](../../../noj-ui/pages/admin/problem-edit/[id].vue) | 待迁移 |
| `/admin/problem-import`    | [现有实现](../../../noj-ui/pages/admin/problem-import.vue)    | 待迁移 |
| `/admin/problem-new-oi`    | [现有实现](../../../noj-ui/pages/admin/problem-new-oi.vue)    | 待迁移 |
| `/admin/problem-new`       | [现有实现](../../../noj-ui/pages/admin/problem-new.vue)       | 待迁移 |
| `/admin/problem-versions`  | [现有实现](../../../noj-ui/pages/admin/problem-versions.vue)  | 待迁移 |
| `/admin/problems`          | [现有实现](../../../noj-ui/pages/admin/problems.vue)          | 待迁移 |
| `/admin/reports`           | [现有实现](../../../noj-ui/pages/admin/reports.vue)           | 待迁移 |
| `/admin/roles`             | [现有实现](../../../noj-ui/pages/admin/roles.vue)             | 待迁移 |
| `/admin/settings`          | [现有实现](../../../noj-ui/pages/admin/settings.vue)          | 待迁移 |
| `/admin/submission-jobs`   | [现有实现](../../../noj-ui/pages/admin/submission-jobs.vue)   | 待迁移 |
| `/admin/submissions`       | [现有实现](../../../noj-ui/pages/admin/submissions.vue)       | 待迁移 |
| `/admin/tags`              | [现有实现](../../../noj-ui/pages/admin/tags.vue)              | 待迁移 |
| `/admin/trainings`         | [现有实现](../../../noj-ui/pages/admin/trainings.vue)         | 待迁移 |
| `/admin/users`             | [现有实现](../../../noj-ui/pages/admin/users.vue)             | 待迁移 |
