# Agent Note: 通用 Markdown 分屏编辑器

Status: implemented

## Problem

题目描述、隐私政策 / 服务条款、站内公告都以 Markdown 存储，但编辑入口不统一：
题目编辑器只有「编辑 / 预览」二选一切换，法律政策与公告只有纯 textarea，
出题人与管理员无法边写边看渲染结果（尤其是 LaTeX 公式与表格）。

## Decision

- 新增 `noj-ui/components/shared/MarkdownEditor.vue`：`v-model` 绑定字符串，
  左侧 textarea 源码，右侧复用 `MarkdownRenderer` 实时预览（与前台渲染、
  DOMPurify 清洗完全一致）。
- 视图三态：编辑 / 分屏（默认）/ 预览；窄屏（< md）分屏退化为上下堆叠。
- 工具栏（标题、加粗、斜体、删除线、引用、列表、表格、链接、图片、代码、公式）
  与快捷键 Ctrl/⌘+B/I/K、Tab 缩进；文本操作抽成 `utils/markdownEditing.ts`
  纯函数，便于单元测试。
- 预览 200ms 防抖，分屏时编辑区滚动按比例同步到预览区。
- 接入：`CodingProblemEditor` 题目描述、`admin/legal` 政策正文、
  `admin/announcements` 公告正文（抽屉加宽到 `sm:max-w-5xl` 以容纳分屏）。

## Alternatives considered

- 引入第三方编辑器（ByteMD、Milkdown、md-editor-v3）：功能更多，但预览渲染管线
  与站内 `MarkdownRenderer`（KaTeX 预处理、外链图片策略、DOMPurify）不一致，
  会出现「预览与线上不同」；且增加包体与单二进制打包风险。
- 基于 Monaco 做源码区：已有自托管 Monaco，但对纯文本 Markdown 过重，
  移动端体验差，且与 v-model 表单集成成本高。

## Consequences

- 预览与线上渲染同源，所见即所得；新增 Markdown 输入应优先复用该组件。
- 公式在预览中的排版受 `sanitize.ts` 禁用 `style` 属性（NOJ-249）影响，
  与前台题面表现一致，需单独处理。
- 竞赛描述、个人简介、社区发帖等其它 Markdown 输入暂未迁移。
