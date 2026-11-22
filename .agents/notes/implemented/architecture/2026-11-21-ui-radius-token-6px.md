# Agent Note: 圆角 token 钉到 2/4/6 与 noj-panel 收口

Status: implemented

## Problem

`dev-docs/design/noj-design-tokens.md` 规定圆角只允许 2–6px（卡片 4px、弹层 6px），
但 `noj-ui/assets/css/main.css` 的 `@theme inline` 把 `--radius-lg` 设为 10px、
`--radius-xl` 设为 14px，且未定义 `--radius-2xl` / `--radius-3xl`：后两者回落到
Nuxt UI / Tailwind 的默认档（旧构建里 `rounded-2xl` 实测
`calc(var(--ui-radius) * 4)` = 16px；`rounded-3xl` 按同一刻度是 24px，本仓库
没有使用点）。于是
"`rounded-lg` / `rounded-xl`" 这些出现在 176 处 S1 代码里的类名，渲染值既不是
4px 也不是 6px，与设计规范脱节。

不能只改类名：token 与类名是两套事实源，只改一边会让 10/14px 继续从
Nuxt UI 内部、S2/S3 存量里漏出来；也不能只改 token：176 处类名仍然表达
"大圆角"的语义，下一次改动还会按 10/14px 的直觉写。

## Decision

- 在 `main.css` 的 `@theme inline` 里把刻度钉死为
  `--radius-sm: 2px`、`--radius: 4px`、`--radius-md: 6px`；`lg` / `xl` / `2xl` /
  `3xl` 一律 6px。别名**保留不删**：Tailwind v4 删掉它们不会禁用类名，只会回落到
  Nuxt UI 的默认档（8 / 12 / 16 / 24px），Nuxt UI 内部仍在用，删了是静默变样。
- 新增 `@utility noj-panel`：`background-color: var(--c-bg-panel)` +
  `border: 1px solid var(--c-border)` + `border-radius: var(--radius)`，让"卡片外壳"
  有语义类，圆角只在 token 里定义一次。
- S1 的 176 处 `rounded-(lg|xl|2xl|3xl)` / `rounded-[…]` 按语义重映射：
  卡片外壳 → `noj-panel`（107 处）、其余圆角块与原生控件 → `rounded-md`（68 处）、
  签到热力格 `rounded-[3px]` → `rounded-sm`（1 处）。没有 `rounded-full` 目标位
  （S1 的头像 / 状态点 / 数字角标本来就是 `rounded-full`）；没有一处保留原类名。
  107 处 `noj-panel` 的原标签都已有 `bg-white` / `bg-bg-panel` 与
  `border border-border`，所以这步只改圆角，不改底色与描边。
- 判定口径：`bg-white` / `bg-bg-panel` + `border border-border` 且是区块容器的
  才算卡片；虚线框、2px 描边、渐变底、`bg-bg-page` / `bg-bg-sunken`、tone 着色、
  图标块、按钮、`pre` 代码块、弹层一律 `rounded-md`（6px）。弹层按规范 6px。
- 棘轮：`--write-baseline` 后 `radius` 从 S1 176 → 0、public 190 → 15、
  all 231 → 55；其余六条规则数字不变（palette 145 / raw-control 74 / type 68 /
  motion 0 / entrance 0 / dark 0）。`--check` 通过。
- 文档同步：`dev-docs/design/noj-design-tokens.md` 的「圆角与排版」与
  `noj-ui/docs/styling.md` 的 token 表改成三档刻度 + 别名说明。

## Alternatives considered

- **只改 token、不动类名**：S1 的 176 处会一起变成 6px，`rounded-lg` 继续在代码里
  承担"大圆角"语义，卡片与内层元素无法区分；而且 4px 的 `noj-panel` 就无从落地。
- **只改类名、不动 token**：`rounded-md` 已是 6px，但 S2/S3 的 `rounded-lg` 仍是
  10px、`2xl/3xl` 仍是 16/24px，规范与实现继续脱节。
- **删掉 lg/xl/2xl/3xl 别名**：最小 diff，但类名不会失效，只会回落到 Nuxt UI 的
  默认档；这是本轮唯一一次全局视觉变化，必须让回落值确定。
- **卡片统一用 `rounded-md`（6px）**：少一个 utility，但规范写的是卡片 4px，
  且 6px 与输入 / 内层元素拉不开层级。
- **顺手改 S2/S3 的类名**：会破坏"S1 优先、S2/S3 只被动跟随"的分刀顺序；
  它们本轮因 token 变化被动变成 6px，是文档写明的预期副作用。

## Consequences

- **本轮唯一一次全局视觉变化**：所有 `rounded-lg` / `rounded-xl`（S1 与 S2/S3）
  从 10 / 14px 变成 6px；`rounded-2xl` / `rounded-3xl` 从 16 / 24px 变成 6px。
  S1 卡片从 10 / 14px 变成 4px。颜色、字号、间距、动效、文案未动。
- S2/S3（admin / editor / problem/ui / objective / 设置 / 域设置 / 新建题目 / 我的）
  的 55 处 `rounded-lg` 类名保持不变，渲染值被动变成 6px，等后续分刀再收口。
- 新增卡片外壳用 `noj-panel`，不再写 `rounded-lg border border-border bg-white`
  三件套；守卫把 S1 radius 锁在 0，回流会直接红灯。
- 签到热力格是 14px 见方，6px 圆角会占宽度 43%，按 2px（`rounded-sm`）保留
  网格观感；这是唯一一处没有落 6px 的 S1 圆角。
- 原生 `input` / `select` / `textarea` 落在 6px（`rounded-md`），与 Nuxt UI
  `UInput` 的默认 `rounded-md` 一致；设计文档里"输入 4px"的写法与现状不符，
  需要 4px 时把这些标签换成 `rounded`（4px）即可。
- `card-elevated` 仍是 `var(--radius-md)`（6px）。它当前全仓零引用，本轮未改；
  它若被启用应改用 `noj-panel` 或 `var(--radius)`。
