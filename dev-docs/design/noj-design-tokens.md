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

## CLI / 终端

终端没有 CSS/HTML，只有 ANSI SGR 转义，而且**前景色与背景色由用户终端决定**——
本规范不假设落在亮色还是暗色纸面上。因此下面这张表是上文色板的**降级表示**，
不是第二套调色板：亮/暗两套 hex 收敛到同一个 16 色 ANSI 槽位，选择标准是
「在浅色终端与深色终端上都可读」。

### 语义色 → ANSI 映射

| Token | 亮色 hex | 暗色 hex | ANSI SGR | 终端效果 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `--c-success-text` | `#007146` | `#00b377` | `\x1b[32m` | 绿色 | 成功/通过 |
| `--c-warning-text` | `#b45309` | `#fbbf24` | `\x1b[33m` | 黄色 | 警告 |
| `--c-error-text` | `#dc2626` | `#ff6b61` | `\x1b[31m` | 红色 | 错误/失败 |
| `--c-info-text` | `#1B2B4A` | `#7C96D6` | `\x1b[36m` | 青色 | 信息 |
| `--c-primary` | `#1B2B4A` | `#7C96D6` | `\x1b[34m` | 蓝色 | 品牌蓝（蓝黑墨）/强调 |
| `--c-signal` | `#00d68a` | `#00e07a` | `\x1b[92m` | 亮绿色 | 评测信号（进行中/动作） |
| `--c-text-muted` | `#6b6e68` | `#6f736d` | `\x1b[90m` | 亮黑（灰） | 弱化文字 |
| `--c-text-secondary` | `#4c4e4a` | `#90938d` | `\x1b[2m` | 暗淡（SGR dim） | 次要文字 |

- Reset 统一用 `\x1b[0m`；**只对语义片段（状态符号、模块前缀）着色，不整行着色**——
  行内自带 SGR 的转发日志会被外层 reset 清掉，理由见 `noj-cli/src/util/color.ts`
  的 `prefixLine` 注释。
- 状态符号：`✓` 成功、`!` 警告、`✗` 错误、`ℹ` 信息。符号与颜色**成对**出现，
  于是颜色被关闭时仅靠符号也能区分语义（色盲友好）。

### 降级规则

任一「关」条件命中即**完全关闭着色**——输出中不得出现任何 ANSI 转义序列
（不是「颜色变淡」）：

| 触发条件 | 行为 | 判定顺序 |
| --- | --- | --- |
| `NO_COLOR` 非空 | 关 | 最高优先级，压过 `--color=always` |
| `--color=never` | 关 | |
| `--color=auto` 且目标流非 TTY（重定向/管道） | 关 | stdout 与 stderr **分别**探测 |
| `--color=always` | 开 | |
| `LOG_COLOR=never` / `LOG_COLOR=always` | 关 / 开 | 仅在 `auto` 下生效 |

判定唯一实现是 `noj-cli/src/util/color.ts` 的 `resolveColor(mode, stream)`；
`noj-cli/src/output/theme.ts` 只消费其结果，**不得**复制一份 `NO_COLOR`/TTY 判定
（两条路径必然漂移）。`--color` 的合法取值与解析见 `parseColorMode`。

### 排版

- 表格列宽按**显示宽度**对齐：CJK 全角字符占 2 列（实现见
  `noj-cli/src/output/render.ts` 的 `displayWidth`）；
- 给定最大宽度时保证总宽 ≤ 该值：先均匀收缩最宽列、超宽单元格以 `…` 截断；
  宽度小于最小可行宽度（每列 1 列 + 列间距）时对整行硬截断，仍保证不超宽；
- 分隔线与表格分隔线使用 ASCII `-`，不用制表符 `─`：`─`(U+2500) 属 East Asian
  Ambiguous，部分终端按 2 列渲染会破坏对齐；
- 空表渲染为空串，不抛错，也不写任何输出流。

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
