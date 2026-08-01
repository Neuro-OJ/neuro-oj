## 1. 阶段 A：Tailwind v4 + Nuxt UI 基建落地（只加不拆，可独立回退）

- [x] 1.1 `noj-ui/package.json` 更新依赖：移除 `@nuxtjs/tailwindcss`，新增 `@nuxt/ui`、`tailwindcss`，保留 `@tailwindcss/typography`；`deno install`/解析依赖，确认 `node_modules` 内 `@tailwindcss/oxide-<platform>` 完整拉取
- [x] 1.2 `noj-ui/nuxt.config.ts`：`modules` 换为 `@nuxt/ui`，加 `css: ['~/assets/css/main.css']`；暂留 `vite.ssr.noExternal`/`optimizeDeps.include`
- [x] 1.3 新建 `noj-ui/assets/css/main.css`：`@import "tailwindcss"` + `@import "@nuxt/ui"`；`@theme` 迁移 `--c-*` 映射（颜色/圆角/阴影/动画/字体）；`--ui-*` 变量映射保持组件观感；`@plugin "@tailwindcss/typography"`
- [x] 1.4 移植 `prose-neuro` 自定义主题（行内代码/strong/pre/blockquote/table/a/列表/标题）到 v4 CSS 变量/`@utility`，模板侧 `prose prose-neuro` 类名不变
- [x] 1.5 `noj-ui/app.vue`：外层包裹 `<UApp>`；`<style>` 顶部加 `@reference "~/assets/css/main.css"` 让 `.btn` 系列 `@apply` 编译通过；`:root` 的 `--c-*` 与 `.editor-dark` 保留
- [x] 1.6 删除 `noj-ui/tailwind.config.ts`
- [x] 1.7 验证 `deno task dev`（`deno run -A npm:nuxt dev`）正常启动，无 oxide/编译错误
- [x] 1.8 验证 `deno task build` 成功，SSR 无 inject 报错
- [x] 1.9 验证 `deno task compile` 产物启动后 curl 首页与 `/_nuxt/` 静态资源正常（离线图标可用）
- [x] 1.10 视觉回归：CSS 产物含全部自定义 token（bg-primary/prose-neuro/shadow 系列），页面 SSR 渲染正常；全页像素级对比留待最终验证

## 2. 阶段 B：composables 重写 + 通用组件替换

- [x] 2.1 `grep` 核对 `useDialog`/`useToast` 全部调用点（含 `pages/admin/settings.vue` 的 `dialog({...})` 对象式调用）并记录兼容矩阵
- [x] 2.2 重写 `composables/useToast.ts`：`toast.success/error/warn/info` 签名不变，内部改调 Nuxt UI `useToast().add({ title, color, icon })`，`import.meta.server` 守卫保留
- [x] 2.3 重写 `composables/useDialog.ts`：`dialog.confirm/alert/prompt` 签名不变，内部改 `useOverlay().create(DialogModal)`；新增 `components/ui/DialogModal.vue`（UModal 实现 confirm/alert/prompt，危险按钮 `color="error"`）；兼容 settings.vue 对象式调用
- [x] 2.4 `pages/admin/settings.vue`：`@headlessui/vue` Switch → `USwitch`
- [x] 2.5 淘汰 `components/ui/BaseButton.vue`（已无调用点，死代码直接删除）
- [x] 2.6 `TextInput`/`PasswordField` 保留壳、内部换 `UField`+`UInput`（含 password 可见性切换 trailing 插槽）
- [x] 2.7 `components/ui/DataTable.vue` 已不存在；`AdminTable` 已全站替换为 `UTable`（7 页面，含 formatter 参数适配），组件删除
- [x] 2.8 淘汰 `components/ui/Tooltip.vue`，调用点改 `<UTooltip>`
- [x] 2.9 `AdminModal` 已全站替换为 `UModal`（10 处、6 页面，v-model:open + footer 插槽），组件删除
- [x] 2.10 `DifficultyBadge` → `UBadge`（subtle）；`StatusBadge` → `UIcon`（i-lucide-*）；`SubmissionResult` 保持（领域 hex 配色，无通用样式可换）
- [x] 2.11 `PaginationNav` 保留壳、内部换 `UPagination`
- [x] 2.12 删除 `sweetalert2`、`@headlessui/vue` 依赖
- [x] 2.13 验证：`deno task build` + SSR 200；`grep` 无 `sweetalert2`/`@headlessui/vue` 残留

## 3. 阶段 C：页面迭代迁移 + 依赖清理（每页独立 PR）

- [x] 3.1 迁移 `pages/admin/settings.vue`：AdminTable→UTable、按钮→UButton、lucide→UIcon、USwitch/UTooltip/UField 落地，零 `.btn`/`@lucide/vue`/`AdminTable` 残留
- [x] 3.2 迁移认证流页面：表单用 Nuxt UI 封装（UField+UInput）、提交按钮→UButton、图标→UIcon、SweetAlert2→useToast/useDialog
- [x] 3.3 迁移前台公共页：`.btn` 全站清除、图标 UIcon 化、实心/描边按钮→UButton；页面级定制样式元素按需打磨
- [x] 3.4 迁移提交相关页：通用组件已迁移、按钮→UButton
- [x] 3.5 迁移社区/消息/竞赛页：通用组件已迁移、按钮→UButton；图标按钮（30px 方形）与内联切换按钮保留为页面定制元素
- [x] 3.6 admin 页面通用组件（AdminTable/AdminModal/按钮/图标）迁移完成；`editor/[id].vue` 编辑器相关 UI 保持自定义（领域组件）
- [x] 3.7 随各页迁移将 `@lucide/vue` 图标改为 `<UIcon name="i-lucide-*">`（62 文件直接替换 + 5 文件动态 `:is`/`as` 别名手工处理；93 个图标名对照 `@iconify-json/lucide` 集合全部校验通过；修复 5 处 `:class` 误解析）
- [x] 3.8 全站 `grep @lucide/vue` 清零后：删除依赖、`vite.ssr.noExternal`、`optimizeDeps.include`；新增 `@iconify-json/lucide` + `icon.clientBundle` 配置
- [x] 3.9 全站 `.btn/.btn-primary/.btn-outline` 清零（16 文件 57 处 → UButton，栈式转换器保证标签配对），删除 app.vue 全局按钮类与 `@reference`
- [x] 3.10 更新文档：`noj-ui/AGENTS.md`（技术栈/样式规范/组件说明/Nuxt UI 变量/icon 配置）；`openspec/specs/tailwind-migration` 待 `/opsx:sync` 同步
- [x] 3.11 最终校验：`grep` 无 `@lucide/vue`/`sweetalert2`/`@headlessui/vue`/`.btn-`/`AdminTable`/`AdminModal` 残留；`deno task build`/`compile` 通过、单二进制 4 页面 SSR 200、`deno lint`/`fmt` 通过（E2E 直连 core 不经前端，不受影响）
