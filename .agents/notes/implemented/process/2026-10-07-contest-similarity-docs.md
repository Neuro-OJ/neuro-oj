# Agent Note: 补充竞赛代码相似度的判定口径、处置与申诉文档

Status: implemented

## Problem

竞赛代码相似度检测（`noj-core/src/domains/contest/services/contest-similarity.ts`、管理端
`GET /api/v1/admin/contest/contests/:id/anti-cheat/similar-submissions`、`noj-ui/pages/admin/contests.vue`
风控面板）已是正式功能，但 `noj-docs` 只有 `system/anti-cheat.md`
的零星机制描述，没有面向运营者 / 选手的算法口径、阈值语义、处置与申诉流程（issue
#582，来源 2026-09-24 文档可读性审计遗留问题 5）。

核对代码时还发现现有文档的不准确之处：

- 「单次分析最大候选池默认为 200」——实际超过 200 时接口抛
  `SIMILARITY_SCALE_EXCEEDED`，不截断；
- 「将变量标识符映射为通用占位符」——实际是按首次出现顺序位置化改写为 `v1..vN`；
- 流程图中的「比对工单」——平台不生成工单；
- 「按 `problem_id` 作用域」——实际按题目 × 语言分桶，且跳过同一用户的提交对；
- `features/contests.md` 结算阶段仍提到已下线的「IP 冲突记录」。

## Decision

- 新增
  `noj-docs/docs/operators/contest-similarity.md`：入口与权限、取数范围与四步算法（参数取自代码常量）、能
  / 不能识别的情形、阈值 / 截断 / 覆盖统计 /
  规模上限的含义、赛后标准处置流程、平台现有处置手段（移除参与者 +
  重新发布带说明的成绩快照、账号封禁）、申诉处理，以及可直接转贴给选手的公开说明模板。
- 明确写出平台**没有**内置相似度申诉工单、答疑区只在赛中开放，申诉渠道须由主办方在竞赛说明中公布，而不是虚构一个产品内流程。
- `features/contests.md`
  增加面向选手的「代码相似度复核与申诉」小节；`system/anti-cheat.md`
  按代码修正上述不准确描述并链接新页；侧边栏与运营者索引加入新页。

## Alternatives considered

- **只写在
  `system/anti-cheat.md`**：该页定位为机制设计说明，混入运营流程会让两类读者都难以找到所需内容。
- **在产品内新增申诉工单 / 处罚状态**：属于功能开发，超出本 issue
  的文档范围；如需要应另开 issue。
- **声明该能力暂不对选手公开解释**：选手被复核时缺少判定依据与申诉路径正是本
  issue 要解决的问题，不采纳。

## Consequences

- 运营者有了与代码一致的处置参照；选手侧通过竞赛机制页和公开说明模板获得判定依据与申诉指引。
- 文档中的数值（阈值 0.8、k=5、w=4、200 候选、50/200 条、20,000 字符、6,000
  token、32 字符下限）与代码常量手工同步，修改常量时需同步本页。
- 权限点 `contest:anti_cheat_read` 的描述文本仍写着「IP 与提交时间线」，与 IP
  关联下线后的实际用途不符，未在本次修改（涉及种子数据）。
