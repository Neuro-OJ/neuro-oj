# nuxt-ui-framework Specification

## Purpose
TBD - created by archiving change nuxt-ui-v4-migration. Update Purpose after archive.
## Requirements
### Requirement: Nuxt UI 集成

noj-ui SHALL 通过 `@nuxt/ui` 模块集成 Nuxt UI v4，通用 UI 组件使用 `U*`
组件（如 `UButton`、`UInput`、`UModal`、`UTable`、`UBadge`、`UTooltip`、
`UPagination`），组件全局注册、模板中直接使用。

#### Scenario: 按钮使用 UButton

- **WHEN** 页面需要渲染按钮
- **THEN** 使用 `<UButton>` 组件，支持 `loading`、`to`（NuxtLink）、
  `color`/变体等能力

#### Scenario: 输入框使用 UInput

- **WHEN** 页面需要表单输入（含密码输入）
- **THEN** 使用 `<UInput>` 组件，密码输入支持可见性切换

### Requirement: 主题 token 映射

noj-ui SHALL 将现有 `--c-*` 设计 token 映射到 Nuxt UI 主题变量（`--ui-primary`、`--ui-bg`、`--ui-border`、`--ui-text` 等），并同时映射品牌蓝 `#1B2B4A` 与评测信号绿 `#00d68a` 系列 token。亮色与暗色模式 SHALL 使用各自对应取值。

#### Scenario: 品牌蓝主色一致

- **WHEN** 渲染 Nuxt UI 主色组件
- **THEN** 亮色模式主色解析为蓝黑墨 `#1B2B4A` 或其映射值，暗色模式解析为可在暗色背景上读写的 `#7C96D6`

#### Scenario: 信号绿组件一致

- **WHEN** 渲染主按钮、选中 Tab、进行中状态或焦点环
- **THEN** 组件颜色解析为评测信号绿 `#00d68a`（亮色）或 `#00e07a`（暗色），并在亮色纸面上使用可读的深绿 `#007146` 作为文字/图标变体

#### Scenario: 暗色编辑器保留

- **WHEN** 进入编辑器暗色上下文（`.editor-dark`）
- **THEN** `--ui-*` 变量随新版 `--c-*` 覆盖联动，组件自动适配暗色

### Requirement: 弹窗行为

通用弹窗（含确认、危险操作确认）SHALL 通过 Nuxt UI 组件（`UModal`/`useModal`）
实现，声明 dialog 语义，支持 Escape 关闭，打开时聚焦弹窗内首个可聚焦元素，
关闭时恢复触发元素焦点。

#### Scenario: 危险操作确认

- **WHEN** 管理员确认删除操作
- **THEN** 弹窗以错误色按钮呈现确认动作，用户可确认或取消

#### Scenario: 键盘关闭

- **WHEN** 用户按 Escape 键关闭弹窗
- **THEN** 弹窗关闭且焦点回到原触发元素

### Requirement: 弹窗与通知包装器兼容

`useDialog`/`useToast` 组合式函数 SHALL 保持现有调用签名（`dialog.confirm/alert/prompt`、
`toast.success/error/warn/info`），内部实现基于 Nuxt UI，调用点无需改动即可获得
等价行为。

#### Scenario: Toast 通知

- **WHEN** 页面调用 `toast.success(...)`
- **THEN** 显示 Nuxt UI 风格的成功通知并自动消失

#### Scenario: 确认弹窗

- **WHEN** 页面调用 `dialog.confirm(...)`
- **THEN** 弹出 Nuxt UI 确认弹窗，返回 Promise<boolean>，用户确认返回 true

### Requirement: 组件自定义边界

编辑器与领域组件 SHALL 保持自定义实现，不使用 Nuxt UI 组件替代：
`MonacoEditor`、`MarkdownRenderer`（markdown-it + KaTeX + highlight.js +
DOMPurify）、`ProblemEditor`、`ResizableSplitter`、`SearchPalette`、
`FollowingFeed` 等。

#### Scenario: Markdown 渲染保持自定义

- **WHEN** 渲染题目描述的 Markdown
- **THEN** 使用 `MarkdownRenderer.vue` 自定义管线，内容经 DOMPurify 清洗

#### Scenario: 代码编辑器保持自定义

- **WHEN** 用户编辑/提交代码
- **THEN** 使用 `MonacoEditor.vue`，不使用库组件替代

### Requirement: 动态类名使用对象映射

所有动态变化的样式类名 SHALL 使用 TypeScript Record 完整字面量字符串映射，
禁止字符串模板拼接类名（该约束对 Nuxt UI 变体切换同样适用）。

#### Scenario: 状态颜色正确

- **WHEN** 提交状态变化
- **THEN** 对应颜色类来自完整字面量映射，构建产物 CSS 未遗漏

