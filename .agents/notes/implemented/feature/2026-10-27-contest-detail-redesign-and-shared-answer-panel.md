# Agent Note: 比赛详情页信息架构重做与题库/比赛作答统一

Status: implemented

## Problem

域比赛详情页（`/d/:slug/contests/:contestId`）只有「标题 + 两个按钮 + 一张卡片 +
报名按钮 + 题目卡片」，缺失赛程规模、赛制说明、榜单可见性、封榜、计分范围、关联班级
等已由后端下发的信息；报名区把「未登录 / 未报名 / 已报名 / 未开始 / 已结束 /
邀请赛需邀请码」全部压在一个 `v-if` 里，导致已结束仍渲染报名按钮、组织者被当成
「未报名」一类处理。比赛赛题页与普通题面页各自实现了一套作答面板
（`DomainContestAnswer` / `DomainProblemAnswer`），字段、校验、文案与错误提示持续
分叉；比赛赛题页还缺少与题库页一致的版本提示条、题面工具条与相邻题目导航。

同时，后端赛题门控把「赛后」与「赛中未报名」同样处理（`status === 'pending' ||
!registered`），已结束的比赛对域内未报名成员仍不可见赛题，复盘与补题无法进行。

## Decision

- **报名状态机收敛为纯函数** `utils/contestWindow.ts`：`contestRegistrationState`
  与 `contestProblemsState` 输出「登录 / 报名 / 已报名 / 已结束」与「赛题可见性」，
  页面只按状态渲染，不再散落互斥 `v-if`；时间窗口、赛程文案、倒计时、榜单可见性与
  赛制口径也放在同一模块，可被 `deno task test` 直接断言。
- **详情页重排信息架构**：赛事头部（状态徽章、公开 ID、赛程/规模/时长、倒计时、主
  操作）+ 左栏（报名 / 赛题 / 说明 / 公告）+ 右侧事实栏（赛制规则、成绩公布方式、
  榜单可见性、封榜、计分范围、关联班级、快捷入口），右侧在桌面端粘性跟随。
- **作答面板统一为 `components/problem/ProblemAnswerPanel.vue`**：它是纯展示组件，
  只接收小题、界面题 HTML、版本与 handlers；题库与比赛各保留一层适配
  （`DomainProblemAnswer` / `DomainContestAnswer`）注入各自数据来源与门控，因此
  比赛的固定版本、独立提交入口、受理窗口、客观题一次交卷、禁止自测全部保留。
- **比赛赛题页与普通题面页共用版式组件**：`ProblemHeader`、`ProblemStatement`
  （含工具条插槽）、`ProblemSamples`、`ProblemAnswerPanel`、`DomainProblemSubmissions`；
  比赛侧只额外加「固定版本」提示条、「受理中 / 未开赛 / 已结束」门控与相邻赛题导航。
- **赛后放开赛题读取**：`getDomainContestProblems` 的判定改为
  「赛前仅组织者；赛中仅参赛者；**赛后对可见本场的所有人开放**」，提交入口仍由
  `getDomainContestSubmissionTarget` 的受理窗口与报名关系限制。赛题页在非受理期
  只读展示题面，不再给出空的编辑器入口。

## Alternatives considered

- 只在现有页面上补充字段（继续用 `v-if` 堆叠）：状态组合继续增加时必然再次遗漏，
  且无法为「已结束 + 未报名」这类语义提供正确文案。
- 让 `ProblemAnswerPanel` 自己调用 API：会让共享组件依赖具体域接口，比赛与题库的
  版本策略、错误码与草稿键无法保持各自语义，也会把 Suspense 边界问题带进共享组件。
- 赛后继续维持「仅参赛者可读」：与产品上「赛后复盘、补题」的预期冲突，且已结束的
  比赛不存在泄题风险；门控收紧没有收益。
- 让未报名者在赛后也能提交：会破坏比赛成绩口径，属于错误放松，因此保留提交门控。

## Consequences

- 后端 `getDomainContestProblems` 行为变更（赛后放开读取），由
  `src/modules/contests/tests/services/domain-contests.test.ts` 的可见性用例覆盖
  （赛前/赛中/赛后三段）。
- 比赛页与题库页作答 UI 共用一份实现；新增题型或校验只需改面板与两个适配层的
  handlers。既有的比赛契约测试（固定版本提交、客观题稳定小题 ID、一次交卷不显示
  隐藏分数）继续通过。
- 详情页新增 `tests/components/DomainContestDetailPage.spec.ts`（六种身份状态）与
  `tests/contestWindow_test.ts`（纯逻辑），面板行为由
  `tests/components/ProblemAnswerPanel.spec.ts` 覆盖。
- 无数据库迁移、无新增环境变量；比赛 SSE 未接入，详情页与赛题页仍以 5 秒轮询兜底。
