# Agent Note: rc/v0.11 大文件按职责拆分

Status: implemented

## Problem

rc/v0.11 有 14 个超过 1000 行的非测试源文件，单文件混合多类职责（读、写、投影、
校验、worker 循环、帮助渲染等），审查与修改都要在一个大文件里来回跳转；其中 4 个
（`contest-similarity.ts`、`noj-cli` 的 `lifecycle.ts` / `cli.ts` /
`prod/config.ts`）超过 1200 行阈值，只能靠 `scripts/check-file-size.ts`
的基线豁免。

## Decision

**纯搬移，零行为变化**：函数体、常量、错误文案、日志与注释原样移动，只改 import
/ export
与必要的可见性（兄弟文件互相引用的私有项改为导出）。原文件保留为门面，对外
导出集合与签名不变，全仓既有导入路径无需改动。

| 原文件                                                    | 拆分前 | 门面 |
| --------------------------------------------------------- | -----: | ---: |
| `noj-cli/src/prod/lifecycle.ts`                           |   1965 |  153 |
| `noj-cli/src/cli.ts`                                      |   1475 |  177 |
| `noj-cli/src/prod/config.ts`                              |   1217 |   92 |
| `noj-cli/src/prod/cli.ts`                                 |   1199 |   81 |
| `noj-cli/src/prod/backup/container.ts`                    |   1020 |  231 |
| `contests/services/contest-similarity.ts`                 |   1314 |  234 |
| `problems/services/problems/problems-crud.ts`             |   1163 |   36 |
| `evaluations/services/queue.ts`                           |   1138 |   26 |
| `evaluations/services/submissions/submissions-crud.ts`    |   1137 |   16 |
| `evaluations/services/versioning/dispatch-job-item.ts`    |   1106 |  318 |
| `evaluations/services/versioning/rejudge-jobs.ts`         |   1074 |   60 |
| `contests/services/contests.ts`                           |   1069 |   21 |
| `evaluations/services/objective/objective-submissions.ts` |   1022 |   19 |
| `noj-judge/src/dual/mod.rs`                               |   1150 |  115 |

拆分后最大的新文件 722
行（`objective-submission-read.ts`）。`check-file-size.ts` 的 `SIZE_BASELINE`
清空（所有登记文件均已低于阈值），依赖“真实仓库存在超阈值 noj-cli
文件”的门禁用例改为断言零错误，noj-cli 纳入扫描由夹具用例覆盖。

验收方式：对每个原文件，把拆分前内容与门面 + 新文件去掉 import/export
后逐行做多重集比对，差异只剩相对路径（文件下沉到子目录）、`export` /
`pub(crate)` / `super::` 可见性前缀与格式化换行。唯一超出纯搬移的是
`dispatch-job-item.ts` 中客观题重判内联块抽成
`dispatchObjectiveRejudge`，调用方传入同一 `item.target_version_id`，语义等价。

## Alternatives considered

- 只给超 1200 行的 4 个文件登记更高基线：不解决职责混杂，基线只会继续膨胀。
- 拆分时顺带重构大函数：会把“搬移”和“改逻辑”混在同一个 diff 里，审查无法逐行确认
  零行为变化，留待后续单独进行。
- `noj-cli/src/cli.ts` 的 `dispatchCommand` 与 `removedCommandNotice` 被
  `commands_test.ts` 按行首正则当作提取锚点，保留在原文件且顺序不变。

## Consequences

- 外部导入路径全部不变；新增的兄弟文件之间单向依赖，不反向引用门面。
- 门禁基线清空后，任何新的超阈值文件都会直接失败，需要拆分或显式登记。
- gateway（`limits.ts`、`routes/llm.ts`）、ui（`pages/admin/settings.vue`）与
  judge 的 `sandbox/container.rs`、`oi/*` 等文件未在本批次拆分。
