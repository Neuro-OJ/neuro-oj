## Purpose

定义 Neuro OJ 前端（noj-ui）Tailwind CSS 迁移规范。将现有手写 CSS 逐步替换为
Tailwind utility classes，使用 `@nuxtjs/tailwindcss` 模块集成，JIT 编译模式。
## Requirements
### Requirement: Tailwind CSS 集成

noj-ui SHALL 通过 `@nuxt/ui` 模块集成 Tailwind CSS v4，编译器基于 Tailwind v4，
仅生成使用到的样式。

#### Scenario: 构建通过

- **WHEN** 执行 `deno task build`
- **THEN** 构建成功，Tailwind v4 生成打包后的 CSS 文件，无 oxide 原生模块加载错误

#### Scenario: 开发 HMR

- **WHEN** 在 `deno task dev` 模式下修改组件的 Tailwind class
- **THEN** 浏览器 HMR 更新样式，不触发全量重新加载

### Requirement: Tailwind 配置映射

项目中 SHALL 使用 CSS `@theme` 定义设计 token，将现有 `--c-*` CSS 变量映射为
Tailwind 主题（颜色 `primary`/`text`/`border`/`bg-page` 系列、圆角、阴影、
动画、字体），并映射到 Nuxt UI 主题变量（`--ui-*`）保持组件观感一致。
原 `tailwind.config.ts` SHALL 被删除，配置全部迁入 `assets/css/main.css`。

#### Scenario: 颜色变量可用

- **WHEN** 在模板中使用 `class="bg-primary text-white"`
- **THEN** 样式正确引用 `var(--c-primary)` 和 `var(--c-white)`

#### Scenario: 加载动画可用

- **WHEN** 在模板中使用 `class="animate-spin"`
- **THEN** 元素显示 0.8s 线性无限旋转动画（与原 `@keyframes spin` 一致）

#### Scenario: Nuxt UI 主色一致

- **WHEN** 渲染 `UButton color="primary"`
- **THEN** 组件主色解析为 `var(--c-primary)`

### Requirement: 动态类名使用对象映射

所有动态变化的 Tailwind 类名 SHALL 使用 TypeScript Record
完整字面量字符串映射，禁止字符串模板拼接类名。

#### Scenario: 难度标签颜色正确

- **WHEN** 题目难度为 `easy`/`medium`/`hard`
- **THEN** 对应的 badge 显示 `bg-green`/`bg-yellow`/`bg-red` 底色

#### Scenario: JIT 未遗漏动态类

- **WHEN** 构建生产包
- **THEN** 所有难度标签的颜色类均出现在产出的 CSS 中

### Requirement: ProblemDescription Markdown 样式

`MarkdownRenderer.vue` SHALL 使用 `@tailwindcss/typography` 插件的 `prose` 类
渲染 Markdown 内容。SHALL 通过 Tailwind v4 CSS 变量/`@utility` 方式定义
`prose-neuro` 自定义主题覆盖以下样式以匹配现有视觉效果：

1. **代码块** — 深色背景 `#0d1117`、圆角 `8px`、左边框 `3px solid #22c55e`
2. **行内代码** — 浅灰背景 `#f1f5f9`、粉红文字 `#be123c`
3. **Blockquote** — 左边框 `3px` 使用 `primary` 色
4. **表格** — 边框、表头背景 `#f8fafc`
5. **KaTeX 公式** — `overflow-x: auto` 防止数学公式溢出
6. **链接** — 使用 `primary` 色、hover 下划线

#### Scenario: 代码块渲染

- **WHEN** 题目描述包含 ```python\nprint("hello")\n```
- **THEN** 代码块显示在 `#0d1117` 背景的容器中，带 `8px` 圆角

#### Scenario: 行内公式渲染

- **WHEN** 题目描述包含 `$E = mc^2$`
- **THEN** KaTeX 渲染为行内数学公式，不换行

#### Scenario: 块级公式渲染

- **WHEN** 题目描述包含 `$$ \sum_{i=1}^n i $$`
- **THEN** KaTeX 渲染为独立行公式，溢出时可横向滚动

### Requirement: 文件迁移完成度

每个 Vue 文件迁移完成后 SHALL 满足以下条件：

1. `<style>` 块（无论是 `scoped` 还是全局）从文件中移除
2. 所有样式效果通过 Tailwind utility classes 实现
3. 模板中原有 CSS 类名被替换

#### Scenario: 迁移后无残留 CSS

- **WHEN** 完成 5 个文件的迁移
- **THEN** 项目中没有 `<style>` 标记的 Vue 文件（ProblemDescription 的 `<style>`
  在不删除的 guard 下移除）

#### Scenario: 视觉回归通过

- **WHEN** 在浏览器中对比迁移前后的页面截图
- **THEN** 所有页面（列表/详情/结果页）和组件（编辑器/Markdown）的视觉效果一致

