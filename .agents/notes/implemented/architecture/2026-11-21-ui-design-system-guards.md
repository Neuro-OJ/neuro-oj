# Agent Note: noj-ui 设计系统守卫与硬棘轮基线

Status: implemented

## Problem

根 `AGENTS.md` 禁令 9 要求前端颜色与圆角遵循
[`dev-docs/design/noj-design-tokens.md`](../../../../dev-docs/design/noj-design-tokens.md)，
但仓库里没有任何机器约束。圆角、Tailwind 原始色板、悬停位移动效、任意值入场
动画、`dark:` 变体、原生控件、手写字号七类存量只靠 review 的记忆守住。2026-11-21
首次实测：S1 523 处、public 587 处、all 863 处（命中次数合计）。

没有守卫的清理不可累积。设某规则基线 167，先清理到 160 时不更新基线：下一个 PR
只要不越过 167 就永远通过，等于把"已还的 7 处"重新发成额度。守卫必须先于清理
存在——否则每一刀都从零数起，而且没有证据证明下一刀之后没有回流。

## Decision

- 新增 `scripts/check-ui-guards.ts`，规则、扫描、报告分层在
  `scripts/lib/ui-guards-{rules,scan,report}.ts`。扫描范围 `noj-ui/**/*.vue`，
  只排除 `node_modules`、`.nuxt`、`.output`、`dist`、`test-results`；仓库根由
  `import.meta.url` 定位，不依赖 cwd。数字口径是**命中次数**，不是文件数。
- 七条规则：`radius`（`rounded-lg|xl|2xl|3xl` 与 `rounded-[…]`）、`palette`
  （Tailwind 原始色板）、`motion`（`animate-ping` / `hover:-translate-y` /
  `transition-all`）、`entrance`（`animate-[…]`）、`dark`（类名里的 `dark:`，
  排除 `--c-bg-dark:` 一类 CSS 变量）、`raw-control`（原生 `button` / 文本类
  `input` / `select` / `textarea`）、`type`（`text-11px` 一类手写字号与
  `text-[Npx]`）。
- 三个作用域：`s1`（首要治理域，排除已划给 S2 的板块）、`public`
  （`pages` + `components`，排除 admin）、`all`（全量，含 admin，只统计、
  不设目标）。基线只记录 scope × 规则的数字。
- **硬棘轮**：`--check` 要求当前与基线逐 scope 逐规则**相等**，`!==` 即失败。
  增长报"违规回流"，下降报"请 `--write-baseline`"。只拦增长时，"基线 167 →
  当前 160 通过但不更新"会让额度永久留在旧基线。
- 基线 `scripts/ui-guards-baseline.json` 只有 `--write-baseline` 能写，写前必须
  通过自检。基线不带文件数与时间戳——新增文件、改名、格式化都不该产生 diff。
- 自检三条，任一失败即红灯：扫描到的 `.vue` 少于 100 个（扫描根或过滤失效）；
  基线缺失 / 版本不符（没有可比对的事实源）；内置探针在任一规则上命中数与
  期望不符（规则本身失效）。
- 探针 `PROBE_SOURCE` 含七类违规各一处，并锁定每条的期望命中数；同时故意放入
  五个反例（CSS 变量 `--c-bg-dark:`、`<input type="checkbox">`、HTML 注释里的
  标签、`text-[#e6edf3]` 颜色任意值、`rounded-tl-xl` 单角圆角），确保"不误伤"
  也被测试覆盖。它防的是**正则退化后的假绿**：规则写坏时命中数归零，基线若在
  此刻重建就会得到一份"零违规"的假基线，之后所有回流都拦不住。
- 注册进 `scripts/gate-list.ts`：`REPO_GATES` 增加
  `deno run -A scripts/check-ui-guards.ts --check`，`GATE_SELF_TESTS` 增加
  `scripts/check-ui-guards_test.ts`。
- 2026-11-21 基线（命中次数）：

  | rule | S1 | public | all |
  |---|---:|---:|---:|
  | radius | 176 | 190 | 231 |
  | palette | 146 | 165 | 301 |
  | motion | 23 | 23 | 28 |
  | entrance | 29 | 29 | 29 |
  | dark | 7 | 13 | 16 |
  | raw-control | 74 | 87 | 127 |
  | type | 68 | 80 | 131 |
  | **合计** | **523** | **587** | **863** |

  扫描文件数：S1 201、public 235、all 277。
- S1 豁免清单（即划给 S2 的板块，2026-11-21 按目录重命名校准）：
  `**/admin/**`、`**/layouts/admin.vue`、`**/editor/**`、`**/problem/ui/**`
  （原 `uiproblem/`）、`**/objective/**`、`**/settings.vue`、
  `**/d/[slug]/settings/**`（工作区设置页）、`**/my/**`、
  `**/problems/new/**`（旧版全局建题向导 `pages/problems/new/*.vue`）、
  `**/d/[slug]/problems/new.vue`（域内新建题目页）、`**/edit.vue`。
  `**/messages/**` 随 v0.11 私信功能下线删除。

## 已知例外

S1 的 `raw-control` 在 2026-11-21 的"原生控件换 Nuxt UI 组件"一刀后为 **1**，
不是 0。唯一保留项是 `noj-ui/components/shared/MarkdownEditor.vue` 的编辑区
`<textarea>`，理由与"随手写的表单控件"完全不同：

- 工具栏与 Ctrl/⌘+B/I/K 直接读写 `selectionStart` / `selectionEnd` 并调用
  `setSelectionRange`；分屏滚动同步读取 `scrollTop` / `scrollHeight` /
  `clientHeight`；
- 它是 grid 子项，高度由 `:style="{ height }"` 直接量测，分屏分隔边框也画在
  textarea 自身；换成 `UTextarea` 会多一层 wrapper，ref 需改读 `.textareaRef`，
  高度、边框与测试替身都要重写。

这是**结构性改写**，不是控件替换；按"不要静默留例外"的原则，代码里在 textarea
上方留了注释，基线也显式锁在 1。改变它的条件：将来需要富文本能力时，整体换成
专用编辑器组件（并重新评估选择区、滚动同步与量测契约），而不是继续往这个原生
textarea 上叠功能。

同次收口后的基线（`--write-baseline` 生成）：S1 `radius`/`palette`/`motion`/
`entrance`/`dark` 均为 0、`raw-control` 1、`type` 68。

## Alternatives considered

- **只拦增长（`>`）**：实现更省事，但把"已清理的数量"变成永久额度，
  下个 PR 加回等量违规仍然绿灯，与棘轮目的相反，否决。
- **按文件建基线**：能发现"某文件 +3、另一文件 −3"的抵消，但组件搬家、改名、
  格式化都会重写基线，diff 噪声大于收益；按 scope × 规则汇总，净变化依旧可见。
- **按文件数计数**：同一文件里再加三处 `rounded-lg` 会被静默吞掉，否决。
- **改用 deno lint / ESLint 自定义规则**：仓库没有 Vue 模板类名级别的 lint 基建，
  "跨文件预算 + 基线"也不是单文件 lint 能表达的语义；独立脚本可被 review 读懂。
- **行内豁免注释（如 `<!-- ui-guard-ignore -->`）**：豁免散落在代码里且没有预算
  上限，长期变成看不见的债；统一走 S1 豁免清单，改动集中在门禁文件。

## Consequences

- CI 与 `check-all` 增加一条门禁。任何降低数字的 PR 必须同时运行
  `--write-baseline` 并提交基线 diff——这份 diff 就是"这一刀还了多少"的凭证；
  忘记更新则门禁报"减少"，无法静默通过。
- 违规回流（例如把 `rounded-xl` 加回去）在 CI 直接失败，并逐条指出 scope 与规则。
- S2 存量（admin / editor / problem/ui / objective / 设置 / 域设置 / 新建题目 /
  编辑页 / 我的）当前只统计、不设目标，是后续逐刀的对象。
- 已知局限：同一 scope 内"这边 +3、那边 −3"的净零变化不可见；规则基于正则，
  `<script>` 里的类名字符串同样计入（它们本来就是类名）；HTML 注释先被抹掉。
- 本次不改任何组件与页面，基线仅记录当前存量；守卫先于清理落地。
