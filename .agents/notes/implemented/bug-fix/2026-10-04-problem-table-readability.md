# Agent Note: 题面 Markdown 表格可读性修复

Status: implemented

## Problem

做题界面题面中的表格在窄屏下被截断、表头文字与底色对比不足、单元格内行内代码撑宽整列，可读性差。

## Decision

仅调整 `noj-ui/assets/css/main.css` 中 `.prose-neuro` 的表格样式：表格可横向滚动；表头改用 `--c-bg-sunken` 底色并显式指定文字色；单元格顶部对齐、去除段落边距；偶数行淡底色；单元格内行内代码允许换行。

## Alternatives considered

在 `MarkdownRenderer.vue` 中为表格包裹滚动容器：需要同步放行 sanitizer 白名单，改动面更大，故仅用 CSS（`display: block; overflow-x: auto`）。

## Consequences

所有使用 `prose-neuro` 的 Markdown 渲染处（题面、公告、社区）表格样式一并生效。表格设为 `display: block` 后不再随内容撑满宽度的表格语义，但视觉上无差异。
