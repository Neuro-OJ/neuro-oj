# Agent Note: noj-ui 高密度重构与深色终端主题

Status: implemented

## Problem

noj-ui 的视觉带有明显的模板感：大卡片、渐变、光斑、圆形奖牌、大图标空态，信息密度低，
不像一个以题目、提交与判定为核心的工具。题库、提交、榜单等列表一屏只能看到很少的行，
且面包屑与正文在部分工作区页面上左边缘错位。

## Decision

1. **信息密度**：题库、提交、比赛、题单、榜单统一为单行表格/列表，数字与题号用等宽
   tabular 数字；判定用「色块 + 文字」、难度用三格刻度；提交详情把判定、得分、时间、
   内存压成一条横栏。`LibraryPageHeader`、`AsyncContent`、`FooterBar`、`RankBadge`
   等共享组件同步收紧，去掉装饰图标与卡片投影。
2. **深色终端主题**：墨黑底、等宽字体为主、琥珀色只用于交互、绿/红/黄只用于判定；
   页面标题带 `> ` 提示符，表头大写。`app.vue` 的 `:root` 保留浅色基线 token，
   `assets/css/main.css` 用 `html:root`（特异性高于 `:root`）整体覆盖 `--c-*`、字体、
   圆角、阴影与 Nuxt UI 中性色阶，不依赖样式表加载顺序。
3. **字体**：Geist / Geist Mono 通过 `@fontsource-variable/*` 随 CSS 自托管（`@nuxt/fonts`
   远程 provider 在大陆不可达），中文回退系统字体。
4. **布局修正**：`BreadcrumbNav` 对所有 `workspace` 布局页面使用容器同宽；顶栏只显示
   logo 图标，避免主域名称与站名重复。

## Alternatives considered

- **可切换的多风格（终端 / 精致现代 / 鲜明个性 / 学术杂志 / 科技风）**：开发期做过
  cookie + `html[data-style]` 的切换方案用于比较，定稿只保留深色终端，删除切换器以免
  维护五套视觉与额外的 SSR cookie 逻辑。
- **直接改写 `app.vue` 的 `:root` 全部 token 为深色**：改动面更大且易漏改编辑器局部
  变量；集中在 `main.css` 一段覆盖更易审阅与回退。
- **Google Fonts 远程加载 Geist**：大陆网络不可达且会拖慢 SSR，改为 npm 包自托管。

## Consequences

- 新增依赖 `@fontsource-variable/geist`、`@fontsource-variable/geist-mono`（`deno.lock`
  由 `deno install` 更新）。
- 少量页面仍写死 `bg-white` 等浅色类，在深色主题下可能露白，需逐页收敛到语义 token。
- 原设计规范 `dev-docs/design/noj-design-tokens.md` 的色值与圆角已不再与实现一致，后续需同步更新。
