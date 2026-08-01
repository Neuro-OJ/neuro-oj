## Why

noj-ui 目前完全依靠手写 Tailwind utility class 组件（44 个组件、约 4791 行），
样式重复严重（`text-[13px]` 出现 81 次、同一输入框 class 串原样重复 4 次、
`@lucide/vue` 81 个图标分散在 67 个文件），弹窗/Toast 依赖 SweetAlert2
（21 个文件直接 import）。随着社区系统、竞赛系统等模块持续扩张，继续手写
会放大维护成本与样式不一致。项目此前唯一的书面决策（`2026-06-22-migrate-ui-tailwind-css`
归档变更）明确"不是组件库的引入时机"，该前置条件现已成熟。

引入 **Nuxt UI v4**（官方 Nuxt 模块，Reka UI + Tailwind CSS v4 内核，125+ 组件，
lucide 图标离线内嵌）作为通用组件框架，配合 **Tailwind v3→v4** 迁移，将通用层
从手写组件切换到成熟库，保留现有 `--c-*` 设计 token 视觉体系。

## What Changes

1. **Tailwind v3→v4 迁移** — 移除 `@nuxtjs/tailwindcss` 模块与 `tailwind.config.ts`，
   改用 `@import "tailwindcss"` + CSS `@theme`（颜色/圆角/阴影/动画/字体 token 从
   JS 配置迁入 CSS）；`@tailwindcss/typography` 自定义 `prose-neuro` 主题用
   v4 CSS 变量方式重写，模板侧 `prose prose-neuro` 类名不变。
2. **接入 Nuxt UI v4** — `nuxt.config.ts` 加 `@nuxt/ui` 模块；`app.vue` 外层包裹
   `<UApp>`；`--c-*` 现有 token 映射到 `--ui-*` 主题变量保持组件默认观感。
3. **通用组件替换** — BaseButton→UButton、TextInput/PasswordField→UInput、
   DataTable/AdminTable→UTable、Tooltip→UTooltip、AdminModal→UModal、
   PaginationNav→UPagination、StatusBadge/DifficultyBadge/SubmissionResult 保留壳换
   UBadge、@headlessui/vue Switch→USwitch；编辑器与领域组件（MonacoEditor、
   MarkdownRenderer、ProblemEditor、SearchPalette 等）保持自定义。
4. **弹窗/Toast 切换** — `useToast`/`useDialog` 包装器签名不变、内部改调 Nuxt UI
   `useToast()`/`useModal()`，逐步移除 `sweetalert2` 依赖。
5. **图标统一** — `@lucide/vue`（81 图标/67 文件）随页面迁移改为 Nuxt UI
   `icon="i-lucide-*"`，最终删除 `@lucide/vue` 依赖及其 vite noExternal/optimizeDeps
   配置。
6. **删除依赖** — 最终移除 `@nuxtjs/tailwindcss`、`sweetalert2`、`@headlessui/vue`、
   `@lucide/vue`，新增 `@nuxt/ui`、`tailwindcss`。
7. **构建链适配** — `deno task dev/build/compile`（`nitro deno-server` preset +
   `deno compile` 单二进制）在新架构下全链路验证通过；`app.vue` 的全局
   `.btn/.btn-primary/.btn-outline` `@apply` 类在 v4 下通过 `@reference` 兼容，
   随页面迁移逐步淘汰。

## Capabilities

### New Capabilities
- `nuxt-ui-framework`: noj-ui 以 Nuxt UI v4 作为通用组件框架的规范——`U*` 组件
  使用约束、`--ui-*` 主题 token 映射、弹窗/Toast 行为（dialog 语义、焦点管理、
  危险操作确认）、组件自定义边界（编辑器/领域组件保持自定义）

### Modified Capabilities
- `tailwind-migration`: 样式体系从 `@nuxtjs/tailwindcss`（Tailwind v3 +
  `tailwind.config.ts` + JIT）改为 Tailwind v4（CSS `@theme` + `@nuxt/ui` 集成），
  `prose-neuro` 自定义主题与设计 token 从 JS 配置迁入 CSS

## Impact

| 维度 | 影响 |
|------|------|
| 代码 | noj-ui：`nuxt.config.ts`、`tailwind.config.ts`（删除）、`app.vue`、`assets/css/main.css`（新增）、`composables/useToast.ts`、`useDialog.ts`、`components/*`（~44 个组件）、`pages/*`（43 个页面）、`utils/*` |
| 依赖 | 移除 `@nuxtjs/tailwindcss`、`sweetalert2`、`@headlessui/vue`、`@lucide/vue`；新增 `@nuxt/ui`、`tailwindcss`；保留 `@tailwindcss/typography` |
| 构建 | `deno task dev/build/compile` 全链路；Tailwind v4 编译器 `@tailwindcss/oxide`（原生依赖，仅构建期）；单二进制体积预期 +15~40MB |
| API | 无变化（纯前端替换，后端 API 不变） |
| 行为 | 无变化（视觉保持，弹窗/Toast 行为等价）；无障碍行为（焦点管理、dialog 语义）由 Reka UI 保证 |
| 文档 | `noj-ui/CLAUDE.md`（样式规范章节）、根 `AGENTS.md`、`openspec/specs/tailwind-migration`、`openspec/specs/nuxt-ui-framework` |
