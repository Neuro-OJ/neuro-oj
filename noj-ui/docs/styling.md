# 样式、主题与品牌 token

规则由 [AGENTS.md](../AGENTS.md) §1 的禁令约束；本文给出可查的表与配置位置。

## 硬规则

- 通用组件用 Nuxt UI v4 `U*`（UButton / UInput / UModal / UTable / UBadge 等），
  **不手写通用组件**。
- 布局与排版用 Tailwind CSS v4 utility 类，**不手写 CSS**：

  ```
  class="flex items-center gap-2 p-4"
  ```

- 复杂或复用的样式组合用 `@apply` 收进 `<style>`。
- 全局主题（颜色、字体、阴影）只在 `assets/css/main.css` 的 `@theme` 与 `--ui-*`
  变量配置； `--c-*` CSS 变量只在 `app.vue:root` 定义。
- `Vue <Transition>`、`::before` / `::after` 伪元素、`@keyframes` 允许保留
  `<style>` 块。

## 仅亮色

`nuxt.config.ts` 里 `ui.colorMode: false`，不跟随系统暗色 —— 否则 `<html>` 加了
`.dark` 会让 Nuxt UI 把原生复选框等渲染成暗色外观。暗色只存在于编辑器
`.editor-dark` 区域。

## 可用 Tailwind 主题色

| 类名前缀                                                                 | 对应 CSS 变量                                                                 |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `primary` / `primary-dark` / `primary-light`                             | `--c-primary*`                                                                |
| `primary-bg` / `primary-hover-bg` / `primary-active-bg` / `primary-text` | `--c-primary-*`                                                               |
| `signal` / `signal-deep` / `signal-dark` / `on-signal`                   | `--c-signal*` / `--c-on-signal`                                               |
| `text` / `text-secondary` / `text-muted`                                 | `--c-text-*`                                                                  |
| `border` / `bg-page` / `bg-panel` / `bg-sunken` / `white`                | `--c-border` / `--c-bg-page` / `--c-bg-panel` / `--c-bg-sunken` / `--c-white` |
| `bg-dark` / `bg-dark-2` / `bg-dark-3`                                    | `--c-bg-dark*`                                                                |
| `success-text` / `info-text` / `warning-text` / `error-text`             | `--c-*-text`                                                                  |
| `rank-gold` / `rank-silver` / `rank-bronze`                              | `main.css @theme`：名次专用，只随 `rank === 1/2/3` 出现                       |
| `selftest` / `selftest-bg`                                               | `main.css @theme`：自测提交类型专用                                           |

- 搜索高亮（`SearchResultItem` 的 `<mark>`）用 `bg-warning-text/20` 而不是
  `bg-warning-bg`：高亮的用途是「被看见」，`#fffbeb` 当底几乎不可见；这是
  `warning-text` 的透明底用法，不算误用。
| `font-mono`                                                              | SF Mono / Fira Code / Consolas                                                |
| `animate-spin-slow`                                                      | spin 0.8s                                                                     |
| `shadow-card` / `shadow-dropdown` / `shadow-modal`                       | 预定义阴影                                                                    |

## Tailwind 扩展配置

| 配置项   | 值                                                               |
| -------- | ---------------------------------------------------------------- |
| 圆角     | `sm: 2px` / `DEFAULT: 4px` / `md: 6px`；`lg` / `xl` / `2xl` / `3xl` 为 6px 别名（必须保留） |
| 过渡时长 | `fast: 150ms` / `DEFAULT: 200ms` / `slow: 300ms`                 |
| 排版插件 | `prose-neuro` 类（自定义代码块 / 表格 / 引用样式）               |
| 字体栈   | `SF Mono → Fira Code → Consolas → monospace`（不指定中文字体）   |
| 数值排版 | 分数 / 耗时 / 排名用 `tabular-nums`                              |

## 品牌 token

| 角色           | 亮色      | 暗色      | 用途                                            |
| -------------- | --------- | --------- | ----------------------------------------------- |
| 品牌天青蓝     | `#0284c7` | `#38bdf8` | 高亮链接、关键按钮、激活项、品牌交互            |
| 深邃科技海军蓝 | `#0b0f19` | `#131b2e` | 暗色底 / 暗色面板；正文另有 Slate 900 `#0f172a` |
| 评测信号绿     | `#059669` | `#00e07a` | 评测状态、提交通过、运行就绪、动作              |

- 圆角 2–6 px（默认 4 px）：卡片外壳用 `noj-panel`（4 px + 1 px 边框），
  其余圆角块用 `rounded-md`（6 px），头像 / 状态点 / 数字角标才用 `rounded-full`；
  数值文本用 `tabular-nums`。
- 改品牌 token
  必须同步：`noj-ui/app.vue`、`noj-ui/assets/css/main.css`、`noj-docs` 主题，
  以及 `dev-docs/design/noj-design-tokens.md`。
- 完整 token 见
  [`dev-docs/design/noj-design-tokens.md`](../../dev-docs/design/noj-design-tokens.md)。
