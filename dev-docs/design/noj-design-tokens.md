# NOJ 设计 Token 规范（Precision Instrument）

> 本文是 NOJ 品牌视觉系统的单一事实来源。前端 token 定义在 `noj-ui/app.vue` 的 `:root` 与 `.editor-dark`，Tailwind/Nuxt UI 映射在 `noj-ui/assets/css/main.css`，文档站主题同步在 `noj-docs/docs/.vitepress/theme/styles/style.css`。

## 设计语言

NOJ 采用 **Precision Instrument（精密评测工作台）** 视觉体系——面向高频刷题、教学审阅与竞赛评测的冷静、精准、高信噪比界面：

- **去噪冷白纸底与纯白工作面**：页面底色 `#f7f8fa`，工作面板 `#ffffff`，沉底表头/代码块/凹槽 `#f1f5f9`，1px 建筑发丝线 `#e2e8f0`（交互强调 `#cbd5e1`）；取消数据页默认背景点阵噪声；
- **深钴天青主交互色**：`#0369a1`（亮色 Sky 700，白底对比度 > 5.7:1）/ `#38bdf8`（暗色 Sky 400），用于主按钮、激活态、焦点环与品牌链接；
- **评测信号绿**：`#047857`（亮色 Emerald 700）/ `#00e07a`（暗色荧光绿），专用于评测通过、运行就绪、提交成功状态；
- **全等宽遥测与状态表达**：分数、耗时、内存、排名、通过率一律使用 `tabular-nums`；状态表达通过语义点、状态徽章与结构化遥测值传递，禁止使用 > 1px 的彩色侧边装饰框；
- **严格 3 档近直角圆角**：`4px`（标签/按钮/输入框）、`6px`（默认卡片/表格容器）、`10px`（命令面板/抽屉/弹窗）。

## 色板

### 1. 表面与边框（Surface & Border）

| Token | 亮色值 | 暗色值（`.editor-dark`） | 用途 |
| --- | --- | --- | --- |
| `--c-bg-page` | `#f7f8fa` | `#0b1120` | 页面画布底色 |
| `--c-bg-panel` | `#ffffff` | `#111827` | 主面板/卡片/表格容器 |
| `--c-bg-card` | `#ffffff` | `#111827` | 兼容别名（同 `--c-bg-panel`） |
| `--c-bg-elevated` | `#ffffff` | `#182235` | 浮层/下拉菜单/命令面板 |
| `--c-bg-sunken` | `#f1f5f9` | `#070b14` | 表头/代码块/凹陷槽 |
| `--c-border` / `--c-border-subtle` | `#e2e8f0` | `#1e293b` | 常规 1px 发丝分割线 |
| `--c-border-strong` | `#cbd5e1` | `#334155` | 悬停态边框/强调分割线 |

### 2. 文字（Typography Colors）

| Token | 亮色值 | 暗色值（`.editor-dark`） | 用途 |
| --- | --- | --- | --- |
| `--c-text` | `#0f172a` | `#f8fafc` | 主正文与标题 |
| `--c-text-secondary` | `#475569` | `#94a3b8` | 次要说明/表格次级列 |
| `--c-text-muted` | `#64748b` | `#64748b` | 辅助标签/时间戳/空态说明 |
| `--c-text-on-color` | `#ffffff` | `#ffffff` | 实心品牌按钮文字 |
| `--c-text-on-dark` | `#f8fafc` | `#f8fafc` | 深色块上正文 |

### 3. 品牌与交互（Brand & Interactive）

| Token | 亮色值 | 暗色值（`.editor-dark`） | 用途 |
| --- | --- | --- | --- |
| `--c-primary` | `#0369a1` | `#38bdf8` | 品牌主色、焦点环、关键交互 |
| `--c-primary-dark` | `#075985` | `#0ea5e9` | 主按钮悬停/深强调 |
| `--c-primary-light` | `#0284c7` | `#7dd3fc` | 浅阶品牌辅助 |
| `--c-primary-bg` | `#f0f9ff` | `rgba(56,189,248,0.12)` | 选中项底色/信息标签底 |
| `--c-primary-hover-bg` | `#e0f2fe` | `rgba(56,189,248,0.2)` | 浅色交互悬停底 |
| `--c-primary-active-bg` | `#bae6fd` | `rgba(56,189,248,0.28)` | 按下态底色 |
| `--c-primary-text` | `#0369a1` | `#38bdf8` | 品牌链接与高亮文字 |
| `--c-signal` | `#047857` | `#00e07a` | 评测信号绿 |
| `--c-signal-deep` | `#065f46` | `#00d68a` | 绿底/浅底上的高对比信号文字 |
| `--c-signal-rgb` | `4,120,87` | `0,224,122` | 信号绿半透明通道 |
| `--c-on-signal` | `#ffffff` | `#0b1120` | 信号绿按钮上的文字 |

### 4. 状态、评测结果与难度（Status, Verdict & Difficulty）

| Token | 亮色值 | 暗色值（`.editor-dark`） | 用途 |
| --- | --- | --- | --- |
| `--c-success-text` | `#047857` | `#00e07a` | 成功/通过 |
| `--c-info-text` | `#0369a1` | `#38bdf8` | 信息/进行中 |
| `--c-warning-text` | `#b45309` | `#fbbf24` | 警告/部分通过 |
| `--c-error-text` | `#be123c` | `#fb7185` | 错误/失败 |
| `--c-verdict-accepted` | `#047857` | `#00e07a` | 全部通过（AC） |
| `--c-verdict-accepted-bg` | `#ecfdf5` | `rgba(0,224,122,0.12)` | AC 浅底 |
| `--c-verdict-partial` | `#b45309` | `#fbbf24` | 部分得分 |
| `--c-verdict-partial-bg` | `#fffbeb` | `rgba(251,191,36,0.12)` | 部分得分浅底 |
| `--c-verdict-wrong` | `#be123c` | `#fb7185` | 答案错误/编译或运行失败 |
| `--c-verdict-wrong-bg` | `#fff1f2` | `rgba(251,113,133,0.12)` | 错误浅底 |
| `--c-verdict-limit` | `#c2410c` | `#fb923c` | 超时/超内存（TLE/MLE） |
| `--c-verdict-limit-bg` | `#fff7ed` | `rgba(251,146,60,0.12)` | 限额超标浅底 |
| `--c-verdict-judging` | `#0369a1` | `#38bdf8` | 评测中 |
| `--c-verdict-judging-bg` | `#f0f9ff` | `rgba(56,189,248,0.12)` | 评测中浅底 |
| `--c-verdict-pending` | `#64748b` | `#94a3b8` | 排队中 |
| `--c-verdict-pending-bg` | `#f1f5f9` | `rgba(148,163,184,0.12)` | 排队中浅底 |
| `--c-diff-easy` | `#047857` | `#34d399` | 简单难度 |
| `--c-diff-medium` | `#b45309` | `#fbbf24` | 中等难度 |
| `--c-diff-hard` | `#be123c` | `#fb7185` | 困难难度 |

## 排版、圆角、阴影与容器宽度

- **无衬线字体栈 `--font-sans`**：`"Inter", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, -apple-system, sans-serif`（完全离线，不请求外网字体 API）；
- **等宽字体栈 `--font-mono`**：`"SF Mono", "Fira Code", "Consolas", "Noto Sans Mono CJK SC", monospace`；
- **圆角（严格 3 档）**：`--radius-sm: 4px`、`--radius-md: 6px`（`--radius: 6px` 默认）、`--radius-lg: 10px`；
- **阴影层次（卡片静置无多余阴影，仅浮层使用投影）**：
  - `--shadow-card`: `0 1px 2px rgba(15, 23, 42, 0.04)`
  - `--shadow-dropdown`: `0 10px 25px -5px rgba(15, 23, 42, 0.08), 0 4px 10px -2px rgba(15, 23, 42, 0.04)`
  - `--shadow-modal`: `0 24px 48px -12px rgba(15, 23, 42, 0.18)`
- **布局宽度单一事实来源**（定义在 `noj-ui/utils/workspace-layout.ts`）：
  - `library`: `1040px`（题库 / 提交记录 / 比赛 / 题单等列表页）
  - `default`: `1152px`（常规域内子页）
  - `problem`: `1280px`（题目详情双栏阅读）
  - `home`: `1320px`（域首页）
  - `workspace`: `1440px`（编辑器/宽表工作区）

## CLI / 终端

终端没有 CSS/HTML，只有 ANSI SGR 转义，且**前景色与背景色由用户终端决定**——本规范不假设落在亮色还是暗色纸面上。下面这张表是上文色板的**降级表示**，选择标准是「在浅色终端与深色终端上都可读」。

### 语义色 → ANSI 映射

| Token | 亮色 hex | 暗色 hex | ANSI SGR | 终端效果 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `--c-success-text` | `#047857` | `#00e07a` | `\x1b[32m` | 绿色 | 成功/通过 |
| `--c-warning-text` | `#b45309` | `#fbbf24` | `\x1b[33m` | 黄色 | 警告 |
| `--c-error-text` | `#be123c` | `#fb7185` | `\x1b[31m` | 红色 | 错误/失败 |
| `--c-info-text` | `#0369a1` | `#38bdf8` | `\x1b[36m` | 青色 | 信息 |
| `--c-primary` | `#0369a1` | `#38bdf8` | `\x1b[36m` | 青色 | 品牌天青蓝/强调 |
| `--c-signal` | `#047857` | `#00e07a` | `\x1b[92m` | 亮绿色 | 评测信号（进行中/动作） |
| `--c-text-muted` | `#64748b` | `#64748b` | `\x1b[90m` | 亮黑（灰） | 弱化文字 |
| `--c-text-secondary` | `#475569` | `#94a3b8` | `\x1b[2m` | 暗淡（SGR dim） | 次要文字 |

- Reset 统一用 `\x1b[0m`；**只对语义片段（状态符号、模块前缀）着色，不整行着色**。
- 状态符号：`✓` 成功、`!` 警告、`✗` 错误、`ℹ` 信息。符号与颜色**成对**出现，保证色盲友好。

### 降级规则

任一「关」条件命中即**完全关闭着色**：

| 触发条件 | 行为 | 判定顺序 |
| --- | --- | --- |
| `NO_COLOR` 非空 | 关 | 最高优先级，压过 `--color=always` |
| `--color=never` | 关 | |
| `--color=auto` 且目标流非 TTY | 关 | stdout 与 stderr **分别**探测 |
| `--color=always` | 开 | |
| `LOG_COLOR=never` / `LOG_COLOR=always` | 关 / 开 | 仅在 `auto` 下生效 |

判定唯一实现是 `noj-cli/src/util/color.ts` 的 `resolveColor(mode, stream)`；`noj-cli/src/output/theme.ts` 只消费其结果。

### CLI 排版

- 表格列宽按**显示宽度**对齐：CJK 全角字符占 2 列（实现见 `noj-cli/src/output/render.ts` 的 `displayWidth`）；
- 分隔线与表格分隔线使用 ASCII `-`，不用制表符 `─`；
- 空表渲染为空串，不抛错，也不写任何输出流。

## 对比度要求

- 正文与辅助文本对所在表面 ≥ 4.5:1（大字 ≥ 3:1）；
- 品牌蓝/信号绿作为文字时，对实际落面 ≥ 4.5:1；
- 键盘焦点环统一 2px 实线 `--c-primary`，与背景形成明确分离。
