# Agent Note: noj-ui 高密度重构与可切换界面风格（默认深色终端）

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
2. **主题 token 化的多风格**：`app.vue` 的 `:root` 保留「精致现代」基线；
   `assets/css/main.css` 用 `html[data-style="…"]` 覆盖同一套 `--c-*`、字体、圆角、阴影
   与 Nuxt UI 中性色阶，提供深色终端 / 精致现代 / 鲜明个性 / 学术杂志 / 科技风五套。
   每套另有少量只在本风格生效的签名细节（终端提示符、三线表、硬投影、网格背景等）。
3. **默认深色终端**：`utils/ui-styles.ts` 的 `DEFAULT_UI_STYLE = 'terminal'`；选择存
   `noj-style` cookie，`app.vue` 在 SSR 阶段写入 `data-style`，首屏不闪烁；未知 cookie
   值经 `normalizeUiStyle` 回退默认。右下角 `StyleSwitcher` 用于比较方案。
4. **字体**：Geist / Geist Mono 通过 `@fontsource-variable/*` 随 CSS 自托管（`@nuxt/fonts`
   远程 provider 在大陆不可达），中文回退系统字体。
5. **布局修正**：`BreadcrumbNav` 对所有 `workspace` 布局页面使用容器同宽；顶栏只显示
   logo 图标，避免主域名称与站名重复。

## Alternatives considered

- **每套风格各写一份组件样式**：改动面大且难维护；token 覆盖只需在 CSS 增加一段。
- **localStorage 记录风格**：SSR 读不到，首屏会先渲染默认风格再闪变，故用 cookie。
- **Google Fonts 远程加载 Geist**：大陆网络不可达且会拖慢 SSR，改为 npm 包自托管。

## Consequences

- 新增依赖 `@fontsource-variable/geist`、`@fontsource-variable/geist-mono`（`deno.lock`
  由 `deno install` 更新）。
- 少量页面仍写死 `bg-white` 等浅色类，在深色风格下可能露白，需逐页收敛到语义 token。
- 风格切换器是比较方案用的临时入口，定稿后应删除或迁入用户设置。
- 原设计规范 `dev-docs/design/noj-design-tokens.md` 的色值与圆角已不再与实现一致，后续需同步更新。
