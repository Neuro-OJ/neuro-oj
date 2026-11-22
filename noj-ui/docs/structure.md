# 前端结构、目录与组件

> 目录树与文件名用 `ls` / `rg` 自查；这里只留看名字看不出来的职责与边界。
> composable 用法见 [composables.md](composables.md)，索引见
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
| `components/`         | 按功能分目录（下节）；根目录只放全局横幅                                                         |
| `composables/`        | 所有 `use*`，camelCase（无 `use-foo.ts`）；API 调用只封装在这里                                  |
| `layouts/`            | `default`（导航 + 页脚）/ `auth` / `admin`（侧栏 + 顶栏）/ `workspace`                           |
| `middleware/`         | `auth` / `admin` / `community-moderation`（[data.md](data.md)）                                  |
| `server/api/`         | `[...slug].ts` 通用代理、`auth/logout.post.ts` 注销（[security.md](security.md)）                |
| `utils/`              | 纯函数与政策：`sanitize-policy.ts`、`ssr-routes.ts`、`default-workspace.ts`、`i18n.ts`           |
| `app.vue`             | 根组件；`--c-*` CSS 变量唯一定义处                                                               |
| `assets/css/main.css` | Tailwind v4 `@theme`（映射 `--c-*`）+ `--ui-*` + `prose-neuro`                                   |

无域前缀的题库、比赛、提交与旧编辑入口在页面 setup 前固定跳转默认域 `main`
（`utils/default-workspace.ts`，301 保护旧书签），旧页面已删除。

## 组件分组（`components/`）

| 分组                                                                                                                   | 职责                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `layout/`                                                                                                              | 导航栏、页脚、侧栏、用户菜单                                                          |
| `editor/`                                                                                                              | Monaco、题目编辑器、工具栏 / 状态栏 / 活动栏 / 分屏                                   |
| `uiproblem/`                                                                                                           | 界面题：沙箱 iframe 渲染题包 `ui.html`（`editor/[id].vue` 按 `submission_mode` 选择） |
| `admin/`                                                                                                               | 管理后台统一表格 / 表单 / 抽屉 / 命令面板                                             |
| `knowledge/`                                                                                                           | 知识点选择、标签、编辑面板（编辑页与审核页共用）                                      |
| `shared/`                                                                                                              | Markdown 渲染 / 编辑、分页导航、品牌 logo                                             |
| `ui/`                                                                                                                  | 异步容器、弹窗、难度徽标、骨架屏、结果卡等通用件                                      |
| `feature/` `card/` `form/` `auth/` `checkin/` `objective/` `problem/` `submission/` `legal/` `education/` `workspace/` | 各业务域的局部组件                                                                    |

## 关键组件

| 组件                             | 说明                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/MarkdownRenderer.vue`    | markdown-it + highlight.js + KaTeX 渲染，**DOMPurify 清洗**防 XSS                                                                                   |
| `shared/MarkdownEditor.vue`      | `v-model` 分屏编辑（编辑 / 分屏 / 预览三态、工具栏、Ctrl+B/I/K、防抖预览、滚动同步）；题目描述、政策、公告都用它，新增 Markdown 输入优先复用        |
| `editor/MonacoEditor.vue`        | 自托管 `public/monaco`，可选 `diff` 模式                                                                                                            |
| `editor/CodingProblemEditor.vue` | 题目编辑器：U/P 类型、`submission_mode`（code/artifact/prediction）、artifact 上限、必填校验；prediction 隐藏 Solution 与 LLM 配置（后端 400 拒绝） |
| `card/SubmissionCard.vue`        | 提交卡片，状态标签着色，点击进详情                                                                                                                  |
| `ui/AsyncContent.vue`            | 异步容器，统一 loading / empty / error                                                                                                              |
| `ui/TableSkeleton.vue`           | 表格骨架屏加载态                                                                                                                                    |

## 组件约定

- `<script setup lang="ts">` Composition API；组件 PascalCase，页面 kebab-case。
- 全局状态用 `useState()` 共享（如 `useAuth` 的 `auth:user`）。
- API 调用封装在 `composables/`；类型写在组件或 composable 内，没有 `types/`
  目录。
- 弹窗与 Toast 基于 Nuxt UI（`useOverlay` / `useToast`），SweetAlert2 已移除。

## Nuxt 配置要点

```ts
// lucide 集合本地打包，SSR / 单二进制离线渲染图标
icon: { serverBundle: 'local', clientBundle: { scan: true, collections: ['lucide'], includeAllCollections: true } }
nitro: { preset: 'deno-server' }        // deno compile 必需
hooks: { close: () => process.exit(0) } // 防止 Nitro 关闭时进程 hang
```

## 已知限制

- SEO 基础已具备（动态页
  `useSeoMeta`、OG、sitemap、robots），结构化数据与关键词策略待补。
- 无图片优化（仅 `logo.jpg`）、无字体优化（系统字体栈，无 web font）。
- 参考：[Nuxt 4](https://nuxt.com/docs) · [Vue 3](https://vuejs.org/) ·
  [Tailwind CSS](https://tailwindcss.com/) ·
  [Monaco](https://microsoft.github.io/monaco-editor/)
