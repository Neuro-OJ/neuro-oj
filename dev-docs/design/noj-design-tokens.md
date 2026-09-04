# NOJ 设计 Token 规范

> 本文是 NOJ 品牌视觉系统的单一事实来源。前端 token 定义在 `noj-ui/app.vue` 的 `:root`，Tailwind/Nuxt UI 映射在 `noj-ui/assets/css/main.css`。

## 设计语言

NOJ 采用「暖纸评测风」：

- **纸与墨是主体**：暖纸底、暖墨文字；
- **品牌蓝是身份**：蓝黑墨 `#1B2B4A`，用于 Logo、导航、品牌识别；
- **评测绿是信号**：`#00d68a`，用于动作、选中、进行中、焦点；
- **近直角**：2–6px 圆角，避免大圆角产品感。

## 色板

### 亮色模式

| Token | 值 | 用途 |
| --- | --- | --- |
| `--c-bg-page` | `#e8e8e2` | 页面纸底 |
| `--c-bg-panel` | `#f2f2ec` | 卡片/面板 |
| `--c-bg-sunken` | `#dfe0d9` | 沉底块 |
| `--c-border` | `#d5d6cf` | 边框 |
| `--c-text` | `#1c1e1b` | 正文 |
| `--c-text-secondary` | `#4c4e4a` | 次要文字 |
| `--c-text-muted` | `#6b6e68` | 弱化文字 |
| `--c-primary` | `#1B2B4A` | 品牌蓝（蓝黑墨） |
| `--c-primary-dark` | `#16233E` | 品牌蓝深色 |
| `--c-primary-light` | `#2C4B9B` | 品牌蓝浅色 |
| `--c-signal` | `#00d68a` | 评测信号绿 |
| `--c-signal-deep` | `#007146` | 亮色纸面上的绿色文字/图标 |
| `--c-signal-rgb` | `0,214,138` | 信号绿半透明层 |
| `--c-on-signal` | `#1c1e1b` | 信号绿底上的文字（亮/暗通用） |
| `--c-success-text` | `#007146` | 成功/通过 |
| `--c-warning-text` | `#b45309` | 警告 |
| `--c-error-text` | `#dc2626` | 错误 |
| `--c-info-text` | `#1B2B4A` | 信息 |

### 暗色模式

| Token | 值 | 用途 |
| --- | --- | --- |
| `--c-bg-page` | `#121310` | 暖黑纸底 |
| `--c-bg-panel` | `#191b17` | 面板 |
| `--c-bg-sunken` | `#0d0e0c` | 沉底块 |
| `--c-border` | `#333631` | 边框 |
| `--c-text` | `#f2f3ef` | 正文 |
| `--c-text-secondary` | `#90938d` | 次要文字 |
| `--c-text-muted` | `#6f736d` | 弱化文字 |
| `--c-primary` | `#7C96D6` | 品牌蓝（暗色可读变体） |
| `--c-primary-dark` | `#6C86C8` | 品牌蓝深色 |
| `--c-primary-light` | `#8BA3DB` | 品牌蓝浅色 |
| `--c-signal` | `#00e07a` | 评测信号绿 |
| `--c-signal-deep` | `#00d68a` | 暗色纸面上的绿色文字/图标 |
| `--c-signal-rgb` | `0,224,122` | 信号绿半透明层 |
| `--c-on-signal` | `#1c1e1b` | 信号绿底上的文字（亮/暗通用） |
| `--c-success-text` | `#00b377` | 成功/通过 |
| `--c-warning-text` | `#fbbf24` | 警告 |
| `--c-error-text` | `#ff6b61` | 错误 |
| `--c-info-text` | `#7C96D6` | 信息 |

## 圆角与排版

- 默认圆角：`--radius: 4px`；
- 小圆角：`--radius-sm: 2px`；
- 中圆角：`--radius-md: 6px`；
- 大圆角：`--radius-lg: 10px`；
- 特大圆角：`--radius-xl: 14px`；
- 数值文本（分数、耗时、排名、提交数）使用 `tabular-nums`。

## 对比度要求

- 正文对纸底 ≥ 4.5:1；
- 品牌蓝/信号绿作为文字时，对实际落面 ≥ 4.5:1；
- 装饰性点阵不参与正文对比度，但应保持低存在感（约 1.06–1.6:1 的合成对比度）。
