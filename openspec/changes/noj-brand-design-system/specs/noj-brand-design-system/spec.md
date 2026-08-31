## Purpose

定义 Neuro OJ 的品牌视觉系统，包括设计 token、全局圆点背景、UI 风格约束和文档同步要求，为产品 icon、文档站、宣传素材与前端开发提供统一视觉语言。

## ADDED Requirements

### Requirement: 品牌设计 Token

NOJ 前端 SHALL 使用统一的品牌设计 token，包含暖纸底、暖墨文字、品牌蓝蓝黑墨、评测信号绿以及对应的亮/暗两套取值。品牌蓝 SHALL 使用 `#1B2B4A`（亮色）与 `#7C96D6`（暗色），评测信号绿 SHALL 使用 `#00d68a`（亮色）与 `#00e07a`（暗色）。

#### Scenario: 亮色模式 token

- **WHEN** 渲染亮色模式页面
- **THEN** 页面使用暖纸 `#e8e8e2` 作为背景，使用暖墨文字，品牌蓝解析为 `#1B2B4A`，评测信号绿解析为 `#00d68a`

#### Scenario: 暗色模式 token

- **WHEN** 渲染暗色模式页面
- **THEN** 页面使用暖黑纸底，品牌蓝解析为可在暗色背景上读写的 `#7C96D6`，评测信号绿解析为 `#00e07a`

#### Scenario: token 单一来源

- **WHEN** 前端组件需要使用品牌颜色
- **THEN** 组件 SHALL 引用 `--c-*` 或映射后的 Tailwind/Nuxt UI token，不得硬编码品牌色值

### Requirement: 全局圆点背景

NOJ 页面背景 SHALL 使用低对比圆点点阵，点阵随页面内容滚动，不得固定于视口；点阵 SHALL 位于正文之下且不干扰文字可读性。

#### Scenario: 亮色模式圆点

- **WHEN** 用户浏览亮色模式页面
- **THEN** 背景显示低对比墨色圆点，间距、大小和透明度可由 token 控制

#### Scenario: 暗色模式圆点

- **WHEN** 用户浏览暗色模式页面
- **THEN** 背景显示低对比浅色圆点，且不高于装饰性对比度阈值

#### Scenario: 随内容滚动

- **WHEN** 用户滚动页面
- **THEN** 圆点作为背景的一部分随内容一起移动，不使用 `background-attachment: fixed`

#### Scenario: 无动画

- **WHEN** 页面加载或滚动
- **THEN** 圆点背景不做动画、不引入 JS，并在 `prefers-reduced-motion` 下保持静态

### Requirement: UI 风格约束

NOJ 前端 SHALL 使用 2–6px 近直角圆角、细边框和克制的阴影；数值类文本 SHALL 使用等宽数字。评测信号绿 SHALL 用于动作、选中、进行中和焦点等交互信号，品牌蓝 SHALL 用于 Logo、导航和品牌识别。

#### Scenario: 近直角圆角

- **WHEN** 页面渲染卡片、按钮或输入框
- **THEN** 默认圆角位于 2–6px 范围，不得使用大圆角风格

#### Scenario: 等宽数字

- **WHEN** 页面展示分数、耗时、排名或提交数
- **THEN** 数字启用 `tabular-nums`，数值变化时不产生横向跳动

#### Scenario: 信号色分工

- **WHEN** 渲染主按钮、选中 Tab、进行中状态或焦点环
- **THEN** 使用评测信号绿表达动作/状态；Logo、导航和品牌链接使用品牌蓝

### Requirement: 非直接致敬约束

NOJ 品牌视觉 SHALL 不直接复刻《明日方舟：终末地》或 `dsh-theme-endfield` 的标志性元素，包括等高线、水印、雷霆大字、信号黄、`#14d0d0` 青、全直角 0 圆角和 `ENDFIELD` 字标。

#### Scenario: 背景元素选择

- **WHEN** 设计或实现 NOJ 背景装饰
- **THEN** 使用 NOJ 自有语义（如圆点、评测刻度、波形），不使用终末地等高线或水印

#### Scenario: 颜色差异化

- **WHEN** 定义 NOJ 强调色
- **THEN** 使用评测绿，不直接使用参考主题的信号黄或武陵青

### Requirement: 文档同步

NOJ 品牌系统 SHALL 同步更新仓库开发文档与文档站，至少包括 `AGENTS.md`、`noj-ui/CLAUDE.md`、`noj-docs` 主题和根 `README.md`，并在 `docs/design/` 中保留设计 token 规范。

#### Scenario: 开发文档引用

- **WHEN** 开发者阅读 `AGENTS.md` 或 `noj-ui/CLAUDE.md`
- **THEN** 文档包含品牌设计的基本说明，并指向 `docs/design/`

#### Scenario: 文档站主题一致

- **WHEN** 构建或预览 `noj-docs`
- **THEN** 文档站主题色与 NOJ 品牌 token 一致
