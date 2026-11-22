# 前端结构、目录与组件

> 目录树与文件名用 `ls` / `rg` 自查；这里只留看名字看不出来的职责与边界。
> 组件命名以本文为准；composable 用法见 [composables.md](composables.md)，索引见
> [AGENTS.md](../AGENTS.md)。

## 职责与技术栈

注册 / 登录 / 个人中心、题目列表与详情、代码编辑提交、评测结果（实时 /
历史）；数据经 Nitro 代理与 noj-core 交互（[security.md](security.md)）。

| 项          | 选择                                                                    |
| ----------- | ----------------------------------------------------------------------- |
| 框架 / 语言 | Nuxt 4（Vue 3）+ TypeScript                                             |
| 样式        | Nuxt UI v4 + Tailwind CSS v4（[styling.md](styling.md)）                |
| 编辑器      | npm `monaco-editor`，postinstall 自托管 `public/monaco`（非 CDN）       |
| 图标        | Nuxt UI `UIcon`（`i-lucide-*` 本地打包，SSR / 单二进制离线可用）        |
| Markdown    | markdown-it + highlight.js + KaTeX + DOMPurify                          |
| 运行时      | Deno 2 开发 / 构建；`deno compile` 单二进制部署（[build.md](build.md)） |

## 目录职责

| 路径                  | 放什么                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `pages/`              | 文件路由，kebab-case；`/d/:slug/*` 域内业务（[workspace.md](workspace.md)），`/admin/*` 实例管理 |
| `components/`         | 按领域分目录（下节）；根目录不再放 `.vue`；自动导入范围见「组件注册」                            |
| `composables/`        | 所有 `use*`，camelCase（无 `use-foo.ts`）；API 调用只封装在这里                                  |
| `layouts/`            | `default`（导航 + 页脚）/ `auth` / `admin`（侧栏 + 顶栏）/ `workspace`                           |
| `middleware/`         | `auth` / `admin` / `community-moderation`（[data.md](data.md)）                                  |
| `server/api/`         | `[...slug].ts` 通用代理、`auth/logout.post.ts` 注销（[security.md](security.md)）                |
| `utils/`              | 纯函数与政策；根层只放横切件，业务件按域分目录（见「utils 分类」）                               |
| `app.vue`             | 根组件；`--c-*` CSS 变量唯一定义处                                                               |
| `assets/css/main.css` | Tailwind v4 `@theme`（映射 `--c-*`）+ `--ui-*` + `prose-neuro`                                   |

无域前缀的题库、比赛、提交与旧编辑入口在页面 setup 前固定跳转默认域 `main`
（`utils/domain/workspace/default-workspace.ts`，301 保护旧书签），旧页面已删除。

## utils 分类

根层只留横切件：`breadcrumb`、`buildInfo`、`draft-storage`、`i18n`、`markdown`、
`publicIdentifiers`、`sanitize`、`sanitize-policy`、`ssr-routes`。其余按域放进
`utils/auth/`、`utils/server/`、`utils/domain/{problem,contest,submission,education,workspace,community}/`。

**新增 utils 子目录必须登记到 `nuxt.config.ts` 的 `imports.dirs`**——自动导入只扫
`composables/` 与 `utils/` 的顶层，未登记的子目录不会被扫描，模板里直接用会得到
`TS2339` 或运行时 `undefined`。与组件目录的 R7 同一规则。


## 组件目录（`components/`）

```text
components/
├── base/             10  无业务语义的原子件（AsyncContent / TableSkeleton / DialogModal / ToastBanner / 分页 / 计数 / 分屏）
├── shared/            4  跨领域业务件（Markdown 渲染与编辑、UserIdentity、LibraryPageHeader）
├── layout/            9  全局框架与横幅（Navbar / FooterBar / UserMenu / Breadcrumb / BrandLogo / 三种全局 Banner / AccountNotifications）
├── home/              3  首页区块（HomeLatestSubmissions / HomeStatsToggle / HomeCheckinPanel）
├── problem/          22  题目域（Header / Statement / MetaCard / Answer / Solutions / Submissions / Workspace / Versions / 标签与自测）
│   ├── objective/     2  客观题（ObjectiveQuestionForm / ObjectiveRichText）
│   └── ui/            2  界面题（UiProblemFrame 渲染题包 iframe / UiProblemRuns）
├── submission/       12  提交与评测（SubmissionCard / SubmissionResult 面板 / SubmissionStatusBadge / QueueRow / CaseResults / 判题动作）
├── contest/           3  竞赛（ContestAnswer / ContestForm / ContestClarificationsPanel）
├── training/          2  题单（TrainingEditor / TrainingAddToMenu）
├── community/         8  社区与私信（CommentCard / ReportModal / Index / PostDetail / 通知与举报详情）
├── ranking/           4  榜单与签到（RankBadge / CheckinCard / CheckinLeaderboard / CheckinContributionGraph）
├── search/            2  搜索（SearchPalette / SearchResultItem）
├── auth/              3  认证（AuthFormCard / AuthTextInput / AuthPasswordField）
├── legal/             1  合规（LegalConsentModal）
├── editor/           13  出题编辑器（Editor* 工具栏/侧栏/运行时 / MonacoEditor / ProblemSampleEditor）
├── admin/            14  后台骨架（Admin* 表格/表单/抽屉/命令面板/实例导航 / 回调目录 / LLM 别名）
├── education/        19  教务（Assignment* / Classroom* / Student* / 作业矩阵与批改）
├── knowledge/         4  知识图谱（KnowledgePicker / Tags / EditorPanel / NextLink）
├── workspace/         6  工作空间（WorkspaceHomeContent / Hero / SettingsShell / InvitationManager / 限额与设置表单）
├── announcements/     4  公告（AnnouncementDetail / List / Manager / Section）
└── legacy/            0  冻结目录，不登记自动导入
```

合计 147 个组件。`problem/` 的 22 不含 `objective/` 与 `ui/`。
`layout/` 里的 `AnnouncementBanner`、`BanBanner`、`EmailVerificationBanner` 是全局框架横幅，
不属于公告业务域，不要移进 `announcements/`。

## 组件命名规则

### 通用规则（R1–R7）

| 编号 | 规则 |
| --- | --- |
| R1 | 组件名 = `PascalCase`，领域目录内的组件**必须**以领域词开头（`problem/ProblemHeader.vue`）。 |
| R2 | 新名字必须全局唯一；`legacy/` 不参与自动导入，不占用组件名。 |
| R3 | 只有 `base/`、`shared/`、`layout/` 豁免领域前缀；`education/` 是第三个豁免目录（见 D2）。 |
| R4 | 后缀语义：`*Modal` 业务弹窗、`*Drawer` 侧边抽屉、`*Section` 页面区块、`*Panel` 可操作面板、`*Card` 可点击卡片、`*Badge` 状态/标识、`*Banner` 横幅、`*Skeleton` 骨架屏。 |
| R5 | 拼写统一：`Checkin`（不再出现 `CheckIn`），与后端 `/api/v1/rankings/checkin` 对齐。 |
| R6 | 目录名用单数、小写单词，子域用短横线或单词（`problem/ui/`）。 |
| R7 | 新增领域目录必须登记到 `components.dirs`（见「组件注册」），未登记不会被自动导入。 |

### v0.11 追加判定（D1–D4）

| 编号 | 判定 |
| --- | --- |
| D1 | `Domain*` 前缀一律拆掉，按所属领域改名：`editor/` 内变 `Editor*`，其余进 `problem/`、`submission/`、`contest/`、`training/`、`workspace/`、`admin/`。 |
| D2 | `education/` 内部保留 `Assignment*` / `Classroom*` / `Student*` 子前缀，不强行加 `Education`。 |
| D3 | `workspace/` 内 `Domain*` → `Workspace*`（如 `WorkspaceHomeContent`），`InvitationManager` 补 `Workspace` 前缀。 |
| D4 | 公告进 `announcements/`；全局横幅 `AnnouncementBanner` 留在 `layout/`。 |

### 命名例外（E1–E10）

| 编号 | 例外 | 原因 |
| --- | --- | --- |
| E1 | `NojPageHeader`（计划中） | 页面骨架统一抬头，唯一 `Noj` 前缀特例，来自 #639。 |
| E2 | `editor/ProblemSampleEditor` | `EditorProblemSampleEditor` 冗长；与 `EditorProblemEditor` 靠 `Sample` 区分。 |
| E3 | `editor/MonacoEditor` | 专有名词，`EditorMonacoEditor` 无意义。 |
| E4 | `RankBadge` / `CheckinLeaderboard` / `CheckinCard` / `CheckinContributionGraph` | 功能词已含域词，`RankingRankBadge` 之类重复。 |
| E5 | `dev/lab/` 的 `Lab` 前缀（规则保留） | 当前无该目录；若恢复，子域前缀不叠加 `DevLab`。 |
| E6 | `problem/ui/` 用 `UiProblem` 前缀 | `UiFrame` 太泛、`ProblemUiFrame` 语序倒置。 |
| E7 | `layout/BanBanner` | 「封禁横幅」语义已明确；如需更明确可改 `AccountBanBanner`，当前不动。 |
| E8 | `education/` 内部子前缀 | 区分作业 / 班级 / 学生三条线；统一 `Education` 前缀会长且无法区分。 |
| E9 | `problem/objective/` 用 `Objective*` | 客观题是题目子域，再叠 `Problem` 会重复。 |
| E10 | `layout/AnnouncementBanner` | D4：全局框架横幅，不属于公告业务域。 |

## 组件注册（`components.dirs`）

`nuxt.config.ts` 用**显式目录清单**，每个目录 `pathPrefix: false`（目录不参与组件名）：

```ts
components: {
  dirs: [
    '~/components/base',
    '~/components/shared',
    '~/components/layout',
    '~/components/home',
    '~/components/problem',
    '~/components/submission',
    '~/components/contest',
    '~/components/training',
    '~/components/community',
    '~/components/ranking',
    '~/components/search',
    '~/components/auth',
    '~/components/legal',
    '~/components/editor',
    '~/components/admin',
    '~/components/education',
    '~/components/knowledge',
    '~/components/workspace',
    '~/components/announcements',
  ].map((path) => ({ path, pathPrefix: false })),
}
```

Nuxt 递归扫描每个登记目录，`problem/objective`、`problem/ui` 不用单列；`legacy/` 故意不登记。
**漏登记一个目录不会构建失败**，表现为该目录组件静默不解析（页面空白 / 未知标签），
新增目录时同时改这里与本文的目录树。

## 关键组件

| 组件 | 说明 |
| --- | --- |
| `shared/MarkdownRenderer.vue` | markdown-it + highlight.js + KaTeX 渲染，**DOMPurify 清洗**防 XSS |
| `shared/MarkdownEditor.vue` | `v-model` 分屏编辑（编辑 / 分屏 / 预览三态、工具栏、Ctrl+B/I/K、防抖预览、滚动同步）；题目描述、政策、公告都用它 |
| `editor/MonacoEditor.vue` | 自托管 `public/monaco`，可选 `diff` 模式 |
| `editor/EditorProblemEditor.vue` | 题目编辑器：草稿 / 版本、发布预检、题包导入、U/P 与 `submission_mode`；prediction 模式隐藏 Solution 与 LLM 配置 |
| `submission/SubmissionCard.vue` | 提交列表卡片（状态徽标、跳转详情） |
| `submission/SubmissionResult.vue` | 详情页整块评测结果：得分 / 耗时 / 内存、编译诊断、子任务、评测输出与沿革 |
| `submission/SubmissionStatusBadge.vue` | 列表内联状态胶囊：等待评测 / 评测中 / 判定结果（只读，不可操作） |
| `problem/ui/UiProblemFrame.vue` | 界面题沙箱 iframe，渲染题包 `ui.html` |
| `base/AsyncContent.vue` | 异步容器，统一 loading / empty / error |
| `base/TableSkeleton.vue` | 表格骨架屏加载态 |

## 组件约定

- `<script setup lang="ts">` Composition API；组件 PascalCase，页面 kebab-case。
- 全局状态用 `useState()` 共享（如 `useAuth` 的 `auth:user`）。
- API 调用封装在 `composables/`；类型写在组件或 composable 内，没有 `types/` 目录。
- 弹窗与 Toast 基于 Nuxt UI（`useOverlay` / `useToast`），SweetAlert2 已移除。
- 组件测试在 `tests/components/*.spec.ts`，按组件文件名一一对应；stub 键是组件名，改名时必须同步。

## Nuxt 配置要点

```ts
// lucide 集合本地打包，SSR / 单二进制离线渲染图标
icon: { serverBundle: 'local', clientBundle: { scan: true, collections: ['lucide'], includeAllCollections: true } }
nitro: { preset: 'deno-server' }        // deno compile 必需
hooks: { close: () => process.exit(0) } // 防止 Nitro 关闭时进程 hang
```

## 已知限制

- SEO 基础已具备（动态页 `useSeoMeta`、OG、sitemap、robots），结构化数据与关键词策略待补。
- 无图片优化（仅 `logo.jpg`）、无字体优化（系统字体栈，无 web font）。
- 参考：[Nuxt 4](https://nuxt.com/docs) · [Vue 3](https://vuejs.org/) ·
  [Tailwind CSS](https://tailwindcss.com/) ·
  [Monaco](https://microsoft.github.io/monaco-editor/)
