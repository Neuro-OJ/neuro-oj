# Agent Note: 代码工作区题面跟随主题

Status: implemented

## Problem

实际暗色截图中，编辑器侧栏题面仍使用黑色文字。旧 scoped CSS 强制正文和标题
颜色，又用全局选择器补偿暗色，覆盖了共享 Markdown 主题变量。

## Decision

删除侧栏的重复颜色覆盖，正文、标题、加粗统一使用现有 prose-neuro 和局部主题
token。保留原编辑器布局、字号和其余交互，不增加主题状态或另一套样式。

## Alternatives considered

- 给暗色选择器增加优先级：继续维护两份颜色定义，未来容易再发生冲突。
- 添加更多主题条件：没有业务必要，共享 token 已完整表达亮暗颜色。

## Consequences

工作区及原编辑器侧栏都继承同一主题依据。亮暗主题实际渲染和文字对比度在最终
浏览器验收记录中确认；不以组件测试代替浏览器 CSS 验证。
