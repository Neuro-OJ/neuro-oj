# Agent Note: noj-ui 高密度重构与终端风格黑白双主题

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
2. **终端风格黑白双主题**：等宽字体为主、页面标题带 `> ` 提示符、表头大写；深色（默认）
   为墨黑底 + 琥珀交互，浅色为纸白底 + 加深琥珀（`#b45309`），判定色取 700–800 档，
   辅助文字在各自底色上均 ≥ 4.5:1。`app.vue` 的 `:root` 保留浅色基线 token；深色用
   `html:root:not([data-theme="light"])`、浅色用 `html[data-theme="light"]` 覆盖，特异性
   都高于 `:root`，不依赖样式表加载顺序。深色下另把 Tailwind 50–300 / 600–900 调色板与
   `bg-white` 重映射为深色底可读的配对。
   选择存在 `noj-theme` cookie（`utils/site-theme.ts`、`composables/useSiteTheme.ts`），
   `app.vue` 在 SSR 阶段写入 `html[data-theme]`，首屏不闪烁；顶栏日月按钮切换。编辑器
   自己的明暗开关不变，亮色时加 `.editor-light` 作用域恢复浅色 token 与原始调色板。
3. **字体**：Geist / Geist Mono 通过 `@fontsource-variable/*` 随 CSS 自托管（`@nuxt/fonts`
   远程 provider 在大陆不可达），中文回退系统字体。
4. **布局修正**：`BreadcrumbNav` 对所有 `workspace` 布局页面使用容器同宽；顶栏只显示
   logo 图标，避免主域名称与站名重复。

## Alternatives considered

- **可切换的多风格（终端 / 精致现代 / 鲜明个性 / 学术杂志 / 科技风）**：开发期做过
  cookie + `html[data-style]` 的切换方案用于比较，定稿只保留终端风格，另提供黑白两套
  明暗主题，避免维护五套视觉。
- **跟随系统 `prefers-color-scheme`**：SSR 拿不到系统偏好，首屏会闪；先做显式开关，
  默认深色。
- **直接改写 `app.vue` 的 `:root` 全部 token 为深色**：改动面更大且易漏改编辑器局部
  变量；集中在 `main.css` 一段覆盖更易审阅与回退。
- **Google Fonts 远程加载 Geist**：大陆网络不可达且会拖慢 SSR，改为 npm 包自托管。

## Consequences

- 新增依赖 `@fontsource-variable/geist`、`@fontsource-variable/geist-mono`（`deno.lock`
  由 `deno install` 更新）。
- 少量页面仍写死 `bg-white` 等浅色类，在深色主题下已由调色板重映射兜底，长期仍应逐页收敛到语义 token。
- 原设计规范 `dev-docs/design/noj-design-tokens.md` 的色值与圆角已不再与实现一致，后续需同步更新。
