# Agent Note: 编辑器 Markdown 主题与局部颜色解析

Status: implemented

## Problem

Issue #649 的代码编辑器侧栏出现白底浅字，普通题面文字几乎不可见。 Tailwind v4
普通 `@theme` 中引用 `--c-*` 的颜色别名在根节点提前解析，
工具类背景仍使用亮色值，而 Markdown 直接读取局部暗色变量。
侧栏的独立黑白覆盖与嵌套 prose 又使正文、标题和粗体的颜色来源不同。

## Decision

主题映射使用 `@theme inline`，让工具类在使用处读取现有 `--c-*`， 跟随
`.editor-dark` 的局部主题。色板数值保持一致。 题面直接复用 `MarkdownRenderer` 的
`prose-neuro`，移除侧栏硬编码文字色、 重复 prose 容器与全局 Markdown
暗色覆盖，文字和面板使用同一套主题变量。

`deno task test:theme` 使用模拟 API 和真实 Chromium，覆盖 1440px / 390px 下
默认暗色、切换亮色、再次切换暗色，检查正文、标题、粗体、列表、链接、行内代码、
表格、引用、公式和代码块的计算颜色与对比度，以及题面横向溢出。 正文对比度至少
4.5:1；现有品牌蓝链接与行内代码按至少 3:1 检查， 本次修复不调整品牌色板。CI 的
UI 检查对生产构建产物运行同一任务。

## Alternatives considered

- 仅修改侧栏文字颜色：无法修复背景工具类提前解析主题别名的问题，其他编辑器面板仍受影响。
- 再叠加局部黑白覆盖：会继续拆分 Markdown 元素的颜色来源，并绕过品牌 token。
- 使用 DOM 模拟器断言 class：不能证明 CSS 变量的解析位置、层叠结果或实际对比度，
  因此回归测试使用真实浏览器。

## Consequences

编辑器面板与 Markdown 在切换主题时同步变色，普通亮色页面继续使用根节点色板。
测试不依赖 core、数据库或生产账户；浏览器运行依赖 Playwright Chromium， CI
安装浏览器后执行，失败时保存截图和服务日志。
