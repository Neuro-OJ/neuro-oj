# Agent Note: 教学多角色界面验收修复与移动端可用性打磨

Status: implemented

## Problem

对 `rc/v0.11` 做教学场景（域管理员 / 教练 / 助教 / 学生 / 域外用户）验收时，真实浏览器走查暴露了一组
界面缺陷与体验问题：

1. 面包屑泄漏原始 UUID：`/d/<slug>/classrooms/<classroomId>` 下八个页面（概览、成员、设置、
   学生训练目录、学生训练档案、创建作业、按比赛成绩补题、申请加入班级）全部渲染 `classroomId` 原文；
   学生训练档案的末段还额外渲染 `userId` 原文。
   `utils/breadcrumb.ts` 对动态段落用 `{ param: 'classroomId' }` 占位，需要页面调用
   `useBreadcrumbParams` 回填；全仓当时只有作业详情页调用。
2. 390px 下班级研练中心指标卡标签被 `truncate` 截成「进行中教学…」「需关注学情…」等残句，
   且四张卡各占满一行，指标区把首屏吃光。
3. `ClassroomContests` 零态用整块空卡片（约 150px）展示「暂无可查看的班级关联竞赛」，
   与「共 0 场」重复，首屏留白。
4. 班级详情的作业计数只说「作业总计 N 份」，接口每页 50 条且不返回 total，
   超过 50 份时分页后仍显示 50，数字失真。
5. 教练任务卡同时给出「进入班级」（ghost）与「查看学情与批改矩阵」（outline）两个并列操作，
   加上班级名、作业名两个链接，同一目标三处入口。
6. 学生视角「当前页作业总数」实际取 `visibleLearningTasks.length`，是分页长度冒充总量；
   「求助与教练答复」把已回复的求助也算进待办。
7. 零值语义色不统一：同一行里「需关注学情」零值用成功绿，「待答复求助」零值用中性灰。
8. 客观题作答面板：单选与判断题也渲染成 `UCheckbox`，屏幕阅读器朗读为复选框，
   用户也看不出「单选」只能选一个。
9. 题目页头部在 390px 把标题列挤到逐字换行，「客观题」徽章竖排成一列字。

## Decision

按「先修缺陷、再收 taste」的顺序就地修复，全部为 UI 层改动，不动接口契约：

- 八个班级子页面补 `useBreadcrumbParams({ classroomId: () => room.data.value?.data.name })`，
  学生训练档案再补一层 `userId: () => student.value?.username ?? '学生档案'`（无 `students:manage`
  拿不到花名册时退化为固定文案，而不是回落 UUID）；面包屑在客户端水合后解析为人类可读名称，
  SSR 首帧仍保留占位不闪错。
- 指标卡统计范围诚实化：工作台接口的求助列表固定 `LIMIT 20`、班级列表固定 `LIMIT 50`，两者都不带
  total。触及上限时指标卡改写成「仅显示最近 20 条 / 仅显示最近 50 个」，班级数与「班级大厅」标签
  加 `+`；「需关注学情」标注「本页任务中」，与分页后的任务列表口径一致。
- 指标卡改为 `grid-cols-2`（移动）/ `xl:grid-cols-4`，图标 `size-9`、标签去掉 `truncate`、
  数值主行 + 「共 N 项」次行，两项分开表达「进行中 / 全部」，移动端从 4 行压到 2 行。
- 零值统一走 `bg-bg-sunken text-text-secondary`，有值时再上 `bg-warning-bg text-warning`。
- 学生视角删除「当前页作业总数」，求助指标改为 open 计数 / 全部计数。
- 学生「我的作业任务」标题在未筛选时显示分页总数 `共 total 项`，筛选后改称「本页筛选 N 项」，
  不再用分页长度冒充总量。
- `ClassroomContests` 的零态与加载失败都压成单行条：失败时是「加载失败 + 错误文案 + 重试」，
  成功零态是「暂无 + 说明 + 前往竞赛中心」；只有有数据时才展开整块卡片。
- 班级详情用 `ASSIGNMENT_PAGE_SIZE = 50` 常量对齐 `listAssignments` 的 limit，满页或翻页时文案
  切到「本页 N 份」，接口补 total 后可直接替换。
- 达标进度条由 `bg-primary` 改为 `bg-success`：与全站「达标 / 完成」的评测绿语义一致，
  同一行里两个零值也统一为中性灰。
- 客观题单选题与判断题改用原生 `input[type=radio]`（`accent-primary`），多选题保留 `UCheckbox`；
  原生 radio 自带互斥语义与方向键切换，且不引入新的组件依赖。
- `ProblemHeader` 在窄屏改为 `flex-col`，统计条独占一行，标题与徽章不再被压缩。
- 单选语义变更同步到断言层：`noj-ui/tests/components` 的 `DomainContestAnswer.spec.ts` 与
  `ProblemAnswerPanel.spec.ts` 改为 `find('input[type="radio"]').setValue(true)`；
  `noj-tests/e2e/browser` 四个文件里选项定位由 `getByRole("checkbox")` 改为 `getByRole("radio")`
  （`workspace-governance.test.ts`、`workspace-teaching-journeys.test.ts`、
  `workspace-classroom-matrix.test.ts`、`workspace-public-mixed-journeys.test.ts`）。
  配置页「暂停此题」开关、发布弹窗里的学生勾选、注册页同意条款仍是 checkbox，保持不动。

## Alternatives considered

- **给作业列表接口加 `total`**：能彻底解决计数问题，但要动 core 分页契约与 UI 分页器，
  超出界面验收的改动面；本轮先用「本页 N 份」如实表达，接口改造留给后续。
- **单选题的三种实现**：保留 `UCheckbox`（语义错误，屏幕阅读器朗读为复选框，用户看不出只能选一）；
  换 `URadioGroup`（能拿 Nuxt UI 统一样式，但需要改造组件测试桩，而它只是样式封装）；
  最终选原生 `input[type=radio]`——自带互斥语义与方向键切换，不引入新依赖，代价是测试要按原生控件定位。
- **把指标卡改成横向滚动**：能保留单行高度，但隐藏了指标数量，滚动容器在桌面端反而更差。
- **助教部分能力**：验收时确认 `classroomCan(detail, capability)` 直接返回 `detail.manages_domain`，
  `TEACHING_CAPABILITIES` 目前是装饰性的（教练与助教权限完全相同）。这属于能力模型产品决策，
  不在本轮 UI 修复范围内，已在验收报告里单列。

## Consequences

- 面包屑不再出现 UUID；`useBreadcrumbParams` 需在客户端挂载后生效，SSR 首帧占位保持原状。
- 移动端指标区高度下降，四个指标仍在首屏内；桌面端保持四列。
- 客观题单选/判断的 DOM 语义从 checkbox 变为 radio；`noj-ui` 两个 vitest spec 与 `noj-tests`
  四个浏览器旅程同步改为按 radio 定位，`deno task test:components` 421 tests 与 E2E browser1-3 全绿。
  多选题仍为 checkbox。
- 指标卡在触及接口上限时不再假装是全域总数：求助显示「仅显示最近 20 条」、班级显示
  「仅显示最近 50 个」并加 `+`，避免超过上限后数字静默变小。
- 班级详情在超过 50 份作业时文案改为「本页 N 份」，不再谎报总数。
- 未解决：作业列表接口无 `total`、通知载荷缺作业名与发起人、助教能力模型装饰化，
  三项均记录在 `rc/v0.11` 验收报告，作为合入后的后续项。
