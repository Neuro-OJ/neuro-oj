# Agent Note: 题目页信息架构重构（两栏布局与题面组件化）

Status: implemented

## Problem

做题人打开一道题时，`noj-ui/pages/problems/[id].vue` 是单栏 `max-w-4xl`：难度、
通过率、时限、内存被压成标题下的一行小图标，「开始编码」CTA、artifact 上传、题解区
各占一张卡片垂直堆叠。全页无锚点、无复制题面能力，宽屏留白浪费，信息检索成本高。

更严重的是结构重复：竞赛做题页
（`pages/contests/[contestId]/problems/[label].vue`）**独立重写了一份题面头部**，
并另建了一套硬编码难度色（`bg-green-100`/`bg-yellow-100`/`bg-red-100`），
与 `DifficultyBadge` 组件已经分叉。同一结构两处维护，改动必然漂移。

## Decision

把 `/problems/:id` 改为洛谷式两栏信息架构，并抽出可在竞赛做题页复用的题面组件：

1. **统一视图模型**（`utils/problemView.ts`）。独立题目接口返回 `Problem`，
   竞赛接口返回 `ContestProblem`，两者形状不同（`id` vs `problem_id`、
   竞赛题无 `type`/`runtime_config`/`tags`/`owner_username`）。
   `toProblemView` / `toContestProblemView` 把两者归一为 `ProblemView`，
   组件只需面对一种形状。放在 `utils/` 而非组件内，与本仓库
   「纯逻辑放 utils、可被 `deno task test` 断言」的既有约定一致
   （同 `utils/problemStats.ts`、`utils/submissionFormat.ts`）。

2. **共用组件**（`components/problem/`）：
   - `ProblemHeader`：编号胶囊 + 类型/客观题徽章 + 标题 + 作者 + 右对齐统计条
     （提交数/通过数/通过率/时间限制/内存限制，客观题隐藏后两项）+ 操作插槽。
   - `ProblemStatement`：题面卡片与工具条（复制题面 / 展开收起 / 在编辑器打开 / 编辑），
     带 `#body` 插槽供竞赛页把客观题作答表单放进同一张卡片。
   - `ProblemMetaCard`（右栏信息/标签/通过率）、`MySubmissionCard`（右栏我的提交）。

3. **硬编码调色板全部改为 `--c-*` token 表达**。竞赛页的 `difficultyLabel` /
   `badgeColors` 两份硬编码随之删除，难度统一走 `DifficultyBadge`。

4. **工具条按形态门控**。`ProblemStatement` 的 `editor-to` 为 `null` 时不渲染
   「在编辑器打开」，因此竞赛页只要不传该 prop 即天然保留
   `canUseEditor`/`accessHint` 的门控语义；独立页传编辑器 URL。
   「返回竞赛」保留在 `ProblemHeader` 的 `leading` 插槽（面包屑由 #512 单独收敛）。

5. **右栏「我的提交」**复用既有 `GET /api/v1/submissions?problem_id=<uuid>&per_page=1`
   （需登录），未登录显示登录引导，失败静默降级为空态；
   `/submissions` 增加 `?problem_id=` 预筛选以承接「全部提交」入口。

6. **统计条遵守赛期抑制契约**。赛事进行中后端把 `submit_count`/`accepted_count`/
   `acceptance_rate` **三者一并**置 null（防算术还原），头部显示
   「竞赛进行中，暂不显示通过率」占位而非空白；不拿仍返回的 `attempt_count` 顶替。

## Alternatives considered

- **保留单栏、只调整间距**：无法解决宽屏留白与信息检索成本，等于不做。
- **让竞赛页继续维护第二份头部**：两处已分叉（第二套难度色），长期必然继续漂移；
  本次以「共用组件 + 视图模型」一次性消除，代价是组件接口比单页内联复杂
  （需同时服务「可进编辑器」与「受门控」两种形态）。
- **在组件内各自请求公开统计**：会让竞赛页也发一次赛中已被抑制的请求；
  改为页面取数、组件纯展示（`stats` / `suppressedReason` 入参），保持组件可测、
  且赛期占位逻辑集中在头部一处。
- **竞赛页时限/内存显示 `0ms`/`0MB`**：竞赛接口根本不返回 `runtime_config`，
  用 0 顶替会被误读为真实限制；改为 `null` 表达「该来源不提供」并由头部隐藏该项。
- **本次加面包屑**：issue 明确列为不做（全站层级导航是 #512 的议题），
  避免在同一 PR 里混入跨 26 页的导航重构。

## Consequences

- 独立题目页与竞赛做题页共用同一套题面/头部组件，难度色只剩 `DifficultyBadge` 一处。
- `ProblemView` 成为题目展示的唯一契约；`ProblemHeader` 在两种来源下都能正确渲染，
  竞赛题因 `null` 时限自然隐藏统计项。
- 组件接口比原来的页内内联复杂（插槽 + 可空 prop），这是换取长期一致性的代价。
- 客观题行为不变：仍内联作答、仍不折叠/不复制；竞赛客观题仍为一次性提交。
- 无后端、无数据库、无配置变更；纯前端。
