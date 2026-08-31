## MODIFIED Requirements

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
