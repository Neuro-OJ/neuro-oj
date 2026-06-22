## Context

noj-ui 当前使用手写 CSS 实现全部样式，分布在 5 个 Vue 文件中总计约 786 行。CSS
变量体系（`--c-*`）已部分定义但未强制使用，多处硬编码颜色值。当前文件：

| 文件                                | CSS 行 | 样式类别                                              |
| ----------------------------------- | ------ | ----------------------------------------------------- |
| `pages/problems.vue`                | 222    | 表格、分页、badge、loading/empty/error 状态、响应式   |
| `pages/problems/[id].vue`           | 270    | grid 布局、sticky 提交面板、编辑器包裹、状态过渡      |
| `pages/submissions/[id].vue`        | 321    | verdict 卡片、代码/输出区、资源消耗表、轮询态         |
| `components/MonacoEditor.vue`       | 8      | 编辑器容器边框                                        |
| `components/ProblemDescription.vue` | 102    | 全局 Markdown 样式（代码块、KaTeX、表格、blockquote） |

迁移时保留现有 Nuxt 3 项目结构，不改变组件逻辑、API 调用方式、路由结构。

## Goals / Non-Goals

**Goals:**

- 建立统一的 Tailwind design token 体系，映射现有 `--c-*` CSS 变量
- 将 5 个文件的手写 CSS 替换为 Tailwind utility classes
- 通过 `@tailwindcss/typography` 插件实现 ProblemDescription 的 Markdown 样式
- 删除所有 `<style>` 块，改由 Tailwind 编译层统一管理样式
- 保证迁移前后视觉一致性（逐像素对比确认）

**Non-Goals:**

- 不改变组件逻辑（script + template 结构不变，仅 style 部分迁移）
- 不改变布局结构（DOM 树不变，仅 class 属性重写）
- 不引入新的 UI 组件或设计体系变更
- 不是 Nuxt UI / Ant Design 等组件库的引入时机

## Decisions

### D1: 使用 `@nuxtjs/tailwindcss` 模块而非手动 PostCSS 配置

**选择：** `@nuxtjs/tailwindcss` v6 Nuxt 模块

**理由：** Nuxt 官方维护，零配置集成，自动处理 PostCSS 链、CSS
提取、HMR。手动配置 `postcss.config.js` + `nuxt.config.ts` 的 `css`
选项需要额外维护且容易与 Nuxt 内置 PostCSS 冲突。

### D2: `tailwind.config.ts` 颜色映射到 CSS 变量而非硬编码值

**选择：** 使用 `var(--c-*)` 引用现有 CSS 变量

```ts
colors: {
  primary: {
    DEFAULT: 'var(--c-primary)',
    dark: 'var(--c-primary-dark)',
    light: 'var(--c-primary-light)',
    bg: 'var(--c-primary-bg)',
    hover: 'var(--c-primary-hover-bg)',
  },
  // ...
}
```

**理由：** 保留已有 CSS 变量体系，后续主题切换能力不受影响。Tailwind 的 `var()`
引用在 v3 中完全支持。若硬编码颜色值，将丢失变量的动态性。

### D3: Markdown 渲染使用 `@tailwindcss/typography` 的 `prose` 类 + 自定义主题

**选择：** 定义 `prose-neuro` 主题覆盖代码块、KaTeX、表格、blockquote 的样式

**理由：** `v-html` 内容无法直接应用 Tailwind utility classes。`prose`
类是标准解法，自定义主题通过
`typography: { theme: { neuro: { css: { ... } } } }`
配置。这是整个迁移中唯一的非纯体力环节。

**替代方案考虑：** 使用 CSS 嵌套 + `@apply` 指令的手写样式文件。但 `@apply` 在
Tailwind v3 中不推荐用于复杂组件样式，且仍需要维护独立的 CSS 文件。

### D4: 不编写 Tailwind 组件抽象层

**选择：** 直接在每个模板中使用 utility classes，不做 `@apply` 组件抽象

**理由：** 786 行 CSS → utility classes
的直接映射是机械替换，过程中的重复模式待积累足够经验后再提炼。过早抽象（如定义
`btn-primary`、`card-base` 等）会导致迁移后仍需维护一套自定义组件类，违背了
Tailwind 的 utility-first 哲学。

### D5: 动态类名使用对象映射而非字符串拼接

**选择：** 使用 TypeScript Record 映射难度/状态到完整 Tailwind 类名字符串

```ts
const badgeColors: Record<string, string> = {
  easy: "bg-green-100 text-green-700",
  medium: "bg-yellow-100 text-yellow-700",
  hard: "bg-red-100 text-red-700",
};
```

**理由：** Tailwind JIT 依赖完整类名字面量进行检测，`bg-${color}-100`
等动态拼接**不会被 JIT
识别**，导致样式丢失。对象映射确保了所有类名在构建时静态可分析。

## Risks / Trade-offs

| 风险                                                                              | 缓解措施                                                                                             |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **模板膨胀** — utility classes 使 HTML 行数增加 30-50%                            | 这是 Tailwind 的默认风格，Nuxt 的 SSR 和压缩不受影响。代码可读性通过合理换行维持。                   |
| **Prose 配置走样** — `@tailwindcss/typography` 默认样式与现有 Markdown 渲染差异大 | 分两步：先安装 prose 观察默认效果，再逐步自定义 `prose-neuro` 覆盖率。用 `git diff` + 视觉对比验收。 |
| **CI 构建时间增加** — Tailwind JIT 首次构建需扫描模板                             | Nuxt 3 + Tailwind v3 的 JIT 首次构建增加 ~2s，增量构建无影响。CI 中可接受。                          |
| **颜色映射遗漏** — 现有 CSS 中部分硬编码颜色未在 `--c-*` 变量中定义               | 迁移前扫描所有硬编码色值，未覆盖的在 `tailwind.config.ts` 的 `extend.colors` 中补充。                |
| **迁移期间不一致** — 部分文件已迁移部分尚未                                       | 批次转换（先组件再页面），每一批完成后即清理该文件的 `<style>` 块，不留中间态。                      |

## Migration Plan

### 批次划分

```
第一批：基础设施 + 简单组件
  1. 安装依赖 (@nuxtjs/tailwindcss, @tailwindcss/typography)
  2. 创建 tailwind.config.ts（颜色 token + 动画 + prose 配置）
  3. 转换 MonacoEditor.vue（8 行 CSS，验证管线通顺）
  
第二批：ProblemDescription Markdown 渲染
  4. 配置 prose-neuro 主题
  5. 转换 ProblemDescription.vue（删除手写 CSS，启用 prose 类）
  6. 视觉验证全部 Markdown 样例（代码块、表格、KaTeX、blockquote）
  
第三批：页面迁移
  7. 转换 problems.vue
  8. 转换 problems/[id].vue
  9. 转换 submissions/[id].vue

第四批：收尾
  10. 全局扫描确认无残留 hand-written CSS
  11. 构建验证 + 视觉回归确认
```

### 回滚策略

- 每个批次独立提交，出问题时 revert 单个 commit
- ProblemDescription 的 prose 配置单独提交（最复杂环节）
- 所有版本控制中保留原文件完整 git 历史
