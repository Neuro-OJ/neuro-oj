## Context

noj-ui（Nuxt 4.4.8 + Vue 3）当前以手写 Tailwind utility class 组件为主：44 个
组件（约 4791 行），`components/ui/` 仅 8 个薄封装；弹窗/Toast 依赖 SweetAlert2
（21 个文件直接 import）；图标用 `@lucide/vue`（81 个、67 个文件）；`@headlessui/vue`
仅 admin 设置的 Switch 使用 1 处。样式重复严重（`text-[13px]` ×81、同一输入框
class 串 ×4）。项目此前唯一书面决策（`2026-06-22-migrate-ui-tailwind-css` 归档）
明确"不是组件库引入时机"。

部署链约束：`nitro deno-server` preset + `deno compile` 单二进制
（`--unstable-byonm --unstable-node-globals --include .output/public`）；开发/构建
用 `deno run -A npm:nuxt`。版本控制用 jj；所有提交 GPG 签名、PR 合入；功能变更
走 OpenSpec。

本变更把通用组件层切换到 Nuxt UI v4（官方 Nuxt 模块，Reka UI + Tailwind CSS v4
内核，125+ 组件，lucide 图标离线内嵌），并随迁 Tailwind v3→v4。

## Goals / Non-Goals

**Goals:**
- 通用组件（按钮/输入/弹窗/表格/标签/提示/分页）全部改用 Nuxt UI，不再手写
- 保留现有视觉：`--c-*` 设计 token 映射到 `--ui-*`，`.editor-dark` 暗色机制不动
- `deno task dev/build/compile` 全链路在新架构下跑通，单二进制产物正常
- 弹窗/Toast 行为等价：`useDialog`/`useToast` 签名不变，调用点零改动
- 无障碍行为（dialog 语义、焦点管理、Escape）由 Reka UI 保证并持平/优于现状

**Non-Goals:**
- 不引入 `@nuxtjs/color-mode` 全局亮/暗切换（项目当前无此功能，保持最小改动）
- 不替换领域组件：MonacoEditor、MarkdownRenderer、ProblemEditor、
  ResizableSplitter、SearchPalette、FollowingFeed 等保持自定义
- 不改变后端 API、路由、数据模型
- 不做大改版 UI 重设计（保留现有观感，仅换实现）

## Decisions

### D1: 组件框架选 Nuxt UI v4（而非 shadcn-vue / Naive UI / Element Plus）

候选：Nuxt UI v4、shadcn-vue、Naive UI、Element Plus。决策依据：

- **Nuxt 生态契合**：Nuxt UI 是官方模块，SSR/`deno-server` preset/`deno compile`
  一等方式；shadcn-vue 在 Nuxt 4 需社区 `shadcn-nuxt` 模块 + `@vueuse/core` SSR
  width 插件 + 别名配置，有已知踩坑；Naive 无官方 Nuxt 模块。
- **图标连续性**：全站 81 个 lucide 图标。Nuxt UI v4 默认 lucide 集合且离线内嵌
  （不依赖 Iconify CDN，契合单二进制离线部署）；Naive/Element 需引入第二套图标
  体系。
- **风格**：Nuxt UI 默认观感（neutral/minimal、`--ui-*` 变量驱动）与现有极简
  风格最接近；Element Plus 偏企业后台，偏离最大。
- **覆盖度**：125+ 开箱组件（UTable 排序分页、UCommandPalette、UForm schema
  校验），直接回应"不再手写"；shadcn 仅 ~40 原语，表格/命令面板仍需自组。

代价：需随迁 Tailwind v4，且 `U*` + `--ui-*` 是新的心智模型。

### D2: Tailwind v3→v4 通过 `@nuxt/ui` 集成，配置 CSS 化

`@nuxt/ui` 在 v4 内部接线 Tailwind v4（`@tailwindcss/vite`），移除
`@nuxtjs/tailwindcss`。`tailwind.config.ts` 删除，设计 token（颜色/圆角/阴影/
动画/字体）迁入 `assets/css/main.css` 的 `@theme` 块与 `--ui-*` 变量。备选
`@config` 保留 JS 配置双轨方案仅作 oxide 失败时的兜底，不作首选。

### D3: token 映射策略——`--c-*` 原样保留，映射 `--ui-*`

`app.vue :root` 的 `--c-*` 变量**原样保留**（它们是既有的单一事实来源），
`main.css` 中通过 `@theme` 建立 `--color-*`/`--radius-*`/`--shadow-*` 主题，并把
`--c-*` 映射进 `--ui-primary/--ui-bg/--ui-border/--ui-text/...`，让 Nuxt UI
组件继承同一套 token。`.editor-dark` 覆盖 `--c-*` 的机制不动，`--ui-*` 因引用
`--c-*` 自动联动。**不引入** `@nuxtjs/color-mode` 全局切换。

### D4: prose-neuro 自定义主题以 v4 CSS 变量方式移植

`@tailwindcss/typography` v0.5.10+ 支持 Tailwind v4（`@plugin "@tailwindcss/typography"`）。
原 `theme.extend.typography.neuro` 的样式改为在 `.prose-neuro` 类上用
`--tw-prose-*` CSS 变量 + 后代选择器重写（行内代码、strong、pre 代码块、
blockquote、table、a、列表标记、标题）。`.editor-dark .prose-neuro` 暗色覆盖
保留。模板侧 `MarkdownRenderer.vue`/`EditorSidebar.vue` 的 `prose prose-neuro`
类名不变。若 `@utility` 对复杂后代选择器不生效，退化为普通 `.prose-neuro`
CSS 类定义。

### D5: app.vue 全局 `.btn/.btn-primary/.btn-outline` 兼容过渡

v4 下 Vue SFC `<style>` 块不再自动注入主题，`@apply` 需 `@reference
"~/assets/css/main.css"` 前缀。第一步加 `@reference` 保证编译通过（52 处/17 文件
的 `.btn` 用法暂不动）；第二步随页面迁移逐步替换为 `<UButton>`，全部替换后删除
`.btn` 系列与 `@reference`。最终态：不保留任何全局按钮工具类。

### D6: 组件替换策略——淘汰 / 保留壳换内部 / 保持自定义

- **淘汰**：BaseButton→UButton、TextInput/PasswordField→UInput、
  DataTable/AdminTable→UTable、Tooltip→UTooltip、AdminModal→UModal、
  @headlessui/vue Switch→USwitch。注意 UTable 具名插槽约定与现有
  `#cell-{key}` 的差异。
- **保留壳换内部**：StatusBadge/DifficultyBadge/SubmissionResult（→UBadge，
  领域逻辑 `getStatusColor` 保留）、PaginationNav（→UPagination）。减少调用点
  改动。
- **保持自定义**：MonacoEditor、MarkdownRenderer、ProblemEditor、
  ResizableSplitter、SearchPalette、FollowingFeed、ChatSidebar、AsyncContent、
  ProblemId、AnimatedCounter 等。

### D7: useDialog/useToast 包装器签名不变、内部换 Nuxt UI

`useToast`/`useDialog` 是 21 个文件的唯一入口。重写内部实现（`useToast().add(...)`、
`useModal()`），保留 `toast.success/error/warn/info` 与 `dialog.confirm/alert/prompt`
签名与 Promise 语义，危险按钮 `color="error"`，`import.meta.server` 守卫保留。
需 `grep` 核对 `pages/admin/settings.vue` 中 `dialog({ title, text, icon, danger,
confirmText })` 对象式调用的实际用法并逐一兼容。完成后删除 `sweetalert2`。

### D8: 图标渐进迁移——`@lucide/vue` → `icon="i-lucide-*"`

增量期保留 `@lucide/vue`（及其 vite noExternal/optimizeDeps），随页面迁移逐步把
`<component :is="icon">` 改为 `<UIcon name="i-lucide-*">`；全站清零后删除依赖与
vite 配置。Nuxt UI 默认 lucide 集合离线内嵌，无 CDN 依赖。

### D9: 实现仍分阶段推进（一个 OpenSpec change，分阶段任务）

用户决策合并为**一个大变更**提案，但实现保持增量：阶段 A（基建：Tailwind v4 +
Nuxt UI 落地，只加不拆）→ 阶段 B（composables + 通用组件替换）→ 阶段 C（逐页
迁移 + 依赖清理）。每阶段独立提交/PR、可独立回退。

## Risks / Trade-offs

- [**最高风险**] `@tailwindcss/oxide` 原生模块在 `deno run -A npm:nuxt` 构建环境
  下初始化失败 → 缓解：确认 node_modules 内 `@tailwindcss/oxide-<platform>`
  完整拉取；兜底用 `@config` JS 配置方案；阶段 A 独立验证，失败即回退。
- [`deno compile` 体积 +15~40MB] → 预期内，记录实测；必要时 `--strip` /
  tree-shaking 评估。
- [`.btn` 的 `@apply` 在 v4 需 `@reference`] → 已规划；路径解析失败则把 `.btn`
  迁入 main.css（其内 `@apply` 天然可用）。
- [`@tailwindcss/typography` v4 兼容] → v0.5.10+ 官方支持；自定义主题用 CSS
  变量重写，验证 `prose-neuro` 视觉。
- [Nuxt UI toast/modal/tooltip 依赖 `<UApp>`] → app.vue 外层包裹 `<UApp>`。
- [UTable 具名插槽语义差异（`#cell-{key}` vs `#{column.key}-cell`）] → 实现期
  逐一核对插槽名。
- [SSR 水合/暗色] → 保持 `.editor-dark` 机制，不引入 color-mode，最小改动。
- [迁移期间双体系共存（Nuxt UI + 手写组件）] → 属预期增量代价，按页面清单
  推进并逐步收敛。

## Migration Plan

1. 阶段 A：`nuxt.config.ts` 切模块、新建 `assets/css/main.css`、`app.vue` 加
   `<UApp>` + `@reference`、删 `tailwind.config.ts`、更新依赖 → 验证
   `dev/build/compile` 三链路 + 视觉无回归。此阶段可独立回退。
2. 阶段 B：重写 useDialog/useToast → 替换通用组件 → 清理 sweetalert2/
   @headlessui/vue → 验证 21 个调用点回归。
3. 阶段 C：按页面清单（admin/settings → 认证流 → 前台公共页 → 提交相关 →
   社区/消息/竞赛 → admin 剩余 + 编辑器页）逐页迁移；全部完成后删除
   `@lucide/vue` 与 `.btn` 全局类，清理文档（noj-ui/CLAUDE.md、AGENTS.md、
   tailwind-migration 规范）→ `/opsx:archive` + `/opsx:sync`。

回滚：每阶段独立提交，问题阶段 `jj undo` 或 revert 该阶段提交即可。

## Open Questions

- `@tailwindcss/oxide` 在 deno 环境的确切行为需在阶段 A 实测确认（最大假设）。
- `@nuxt/ui` 在 `deno compile` 单二进制下的最终体积增量待实测。
- `pages/admin/settings.vue` 的 `dialog(...)` 对象式调用与 `useDialog` 导出签名
  的实际差异，需实现期 `grep` 核对后兼容。
