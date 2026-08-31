## Why

当前 NOJ 缺少统一的品牌视觉系统：品牌色仍使用常见 UI 蓝色，没有全局设计 token 规范。随着社区、文档站和宣传场景扩大，需要一套可传承、可扩展的视觉语言，同时服务产品 icon、文档站与宣传素材。

本变更吸收「纸墨 + 信号色」这类工业编辑方法论（参考《明日方舟：终末地》与 `dsh-theme-endfield` 的部分设计思路），但**不直接复制**参考元素；所有颜色、纹理、名字和装饰都替换为 NOJ 自己的语义：暖纸、墨字、蓝黑墨品牌蓝、评测信号绿和圆点纸纹。

## What Changes

- 引入 NOJ 品牌设计 token：暖纸底、暖墨文字、品牌蓝 `#1B2B4A`、评测信号绿 `#00d68a`，以及亮/暗两套对应变体。
- 将全局背景从纯色/冷色系改为**低对比圆点点阵**，点阵随内容滚动（非 `fixed`），营造“评测稿纸”质感。
- 统一 UI 风格：2–6px 近直角、数字等宽、评测绿作为交互/进行中/选中信号，品牌蓝用于 Logo/导航/品牌识别。
- 建立 NOJ 设计资产规范：产品 icon、文档站与宣传素材的视觉使用边界。
- 更新开发文档：`AGENTS.md`、`noj-ui/CLAUDE.md`、`noj-docs`、`README.md`、设计规范文档等。

## Capabilities

### New Capabilities

- `noj-brand-design-system`: 定义 NOJ 品牌设计 token、全局点阵背景、UI 风格约束和文档同步要求。

### Modified Capabilities

- `nuxt-ui-framework`: 将新版 `--c-*` token 与 `--signal-*` 映射到 Nuxt UI 主题变量。
- `documentation-site`: 文档站主题与 NOJ 品牌视觉保持一致。

## Impact

- 修改 `noj-ui/app.vue` 与 `noj-ui/assets/css/main.css` 中的设计 token。
- 修改 `noj-ui` 布局/全局样式，加入圆点背景与圆角、字号、数字等宽等样式约束。
- 新增 `docs/design/` 下的品牌设计规范。
- 更新 `AGENTS.md`、`noj-ui/CLAUDE.md`、`noj-docs` 文档站主题和 `README.md`。
- 不修改数据库 Schema、后端业务逻辑、评测沙箱或生产部署安全边界。
- 不新增外部运行时依赖；点阵背景使用纯 CSS 实现。
