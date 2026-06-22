## Why

当前 noj-ui 的手写 CSS（786 行分散在 5 个文件中）存在以下问题：

- **样式不一致** — 每个组件各自定义颜色、间距、圆角，没有统一的 design token
- **维护成本高** — 新增组件需要查阅现有 CSS 变量和样式类，难以复用
- **响应式代码冗余** — 每个文件都要手写 `@media` 断点
- **CSS 变量未完成** — 多处硬编码颜色值（`#fef2f2`、`#0d1117` 等），主题化困难

迁移到 Tailwind CSS 可以建立统一的 design token 体系，消除手写 CSS，使 UI
开发效率与新组件一致性同步提升。

## What Changes

1. **安装 Tailwind CSS** — 通过 `@nuxtjs/tailwindcss` Nuxt 模块集成
2. **新增 `tailwind.config.ts`** — 定义颜色 token、动画、响应式断点，映射现有
   CSS 变量
3. **新增 `@tailwindcss/typography` 插件** — 替换 `ProblemDescription.vue`
   的全局 Markdown 样式
4. **转换 5 个 Vue 文件** — 将 `<style scoped>` 中的手写 CSS 替换为 Tailwind
   utility classes
5. **删除所有手写 CSS** — 迁移完成后移除各文件的 `<style>` 块
6. **验证** — 视觉对比确认每个页面/组件的样式、动效与原版一致

## Capabilities

### New Capabilities

- `tailwind-migration`: 将 noj-ui 的样式系统从手写 CSS 迁移至 Tailwind
  CSS，包括配置体系建立和 5 个 Vue 文件/组件的样式转换

### Modified Capabilities

（无 — 纯技术栈替换，用户功能不变，API 不变，行为不变）

## Impact

| 维度     | 影响                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| 代码     | 5 个 Vue 文件：~786 行 CSS 替换为 Tailwind utility classes；新增 2 个配置文件 |
| 依赖     | 新增 `@nuxtjs/tailwindcss`、`tailwindcss`、`@tailwindcss/typography`          |
| 构建     | 增加 PostCSS + Tailwind JIT 编译步骤（~1-2s 构建延迟）                        |
| 运行时   | 零变化 — Tailwind JIT 仅生成使用到的 CSS，产物体积持平                        |
| 学习曲线 | 团队需熟悉 Tailwind utility 命名；`@tailwindcss/typography` 配置有一定复杂度  |
