# Agent Note: 客观题富文本渲染、KaTeX 样式修复与套卷编辑器改版

Status: implemented

## Problem

出题文档（`problemsetters/objective-problem.md`）声明客观题题干与选项「原生支持 Markdown 格式与 LaTeX 科学公式」，但前端两处答题界面（`ObjectiveAnswerForm.vue`、竞赛题目页 `contests/[contestId]/problems/[label].vue`）都用 `{{ q.prompt }}` / `{{ opt.text }}` 纯文本插值，表格与公式原样显示为源码；套卷编辑器也只有 2 行文本框、无任何格式提示或预览。

## Decision

- 新增 `components/objective/ObjectiveRichText.vue`：薄封装 `MarkdownRenderer`（已具备 markdown-it 表格、KaTeX、DOMPurify 清洗），追加 `prose-sm` 与首尾块外边距清零，适合嵌入选项行。
- 两处答题界面的题干、选项（单选 / 多选 / 判断）与练习模式解析统一改用该组件；选项行改为顶部对齐，避免多行内容时单选框垂直居中错位。
- 提交记录明细原先显示整段题干原文，含表格时会刷屏，改为显示「第 N 题」。
- 套卷编辑器：题干 / 解析文本框自适应高度，增加格式说明，并在表单下方给出与答题页一致的实时预览。
- **KaTeX 排版修复（全站）**：`MarkdownRenderer` 原先先渲染 KaTeX 再经 DOMPurify（`FORBID_ATTR: ['style']`），KaTeX 依赖的内联 `height` / `top` / `vertical-align` 全被剥掉，分式、上下标、求和上下限错位（浏览器实测 KaTeX 输出 `[style]` 数为 0）。改为公式先换成仅含字母数字的占位符（带随机 nonce），Markdown 渲染与净化之后再回填 KaTeX HTML；回填只发生在文本节点，落在标签内（属性值）的占位符丢弃，防止属性逃逸。KaTeX 默认 `trust: false`，不产出 `\href` / `\htmlStyle` 等指令。生产 CSP 为 `style-src 'self' 'unsafe-inline'`，内联样式可生效。
- **套卷编辑器改版**（`ObjectiveProblemEditor.vue` + 新组件 `ObjectiveQuestionForm.vue`）：
  - 标题 / 描述输入框此前未占满宽度（Nuxt UI 输入框默认非块级），改为全宽，描述随内容自动增高；
  - 小题列表由「单行截断的源码」改为渲染后的题面 + 正确答案绿色高亮 + 可折叠解析；
  - 编辑表单原先固定在页面最底部，改为在被编辑小题的原位置展开，新建时出现在列表末尾并自动滚动到可视区；
  - 选项改为可自动增高的多行输入；题型改为分段切换，切换时清空旧答案；删除选项后按 A/B/C… 重排键名并迁移答案；
  - `⌘/Ctrl + Enter` 保存、「保存并继续添加」；切换小题、取消、离开路由时如有未保存修改先确认；
  - 删除确认框改为显示题号（题干可能含表格 / 公式源码）。
- 答题页 / 竞赛题目页加载小题期间原先显示「该套卷暂无小题」，改为加载态（`useFetch` 的 `status`）。
- 测试：`ObjectiveRichText.spec.ts`（表格、KaTeX、净化剥 style 后公式样式仍在、属性内占位符不回填）、`ObjectiveQuestionForm.spec.ts`（重排键名与答案迁移、切题型清答案、单选替换、快捷键与按钮事件）。

## Alternatives considered

- **选项用 `md.renderInline` 行内渲染**：排版更紧凑，但不支持表格与独立行公式；改用块级渲染 + 外边距清零兼顾两者。
- **只修答题页、不改编辑器**：出题人看不到渲染效果，公式写错只能发布后才发现，故一并加预览。
- **DOMPurify 放行 `style` 或用 hook 仅对 KaTeX 节点放行**：放行 style 扩大攻击面（CSS 注入、覆盖页面元素）；hook 需判断节点是否属于 KaTeX，易被伪造的 `class="katex"` 绕过。净化后回填只信任 KaTeX 自身输出，边界更清晰。
- **小题拖拽 / 上下移动排序**：`sort_order` 有 `UNIQUE(paper_id, sort_order)`，交换需多次请求且非原子，本次不做，后续可加批量重排接口。

## Consequences

- 选项 / 题干文本按 Markdown 解析：以 `1. `、`- `、`# ` 开头的纯文本会被渲染为列表 / 标题，与编程题题面行为一致。
- happy-dom 下 DOMPurify 会剥掉全部标签，组件测试中净化替换为直通，仅验证渲染；XSS 清洗仍由 `MarkdownRenderer` 既有的 DOMPurify 路径负责。
