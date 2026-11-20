# Agent Note: P3 problems/contests 业务边界与只读政策

Status: implemented

## Problem

题目业务和竞赛业务在迁移期间互相导入运行时合同，题目列表还直接依赖 query
聚合、search writer 和 submission 投影 revision。这样会把跨模块副作用藏在业务
服务中，并使题目、竞赛、评测的运行时依赖形成不可收敛的环。

## Decision

- 竞赛保密、准入、固定版本和赛期 SQL 事实统一由
  `src/modules/access/contest-policy.ts` 读取共享 schema；problems 只依赖该政策，
  contests 继续通过 `src/modules/problems/contracts/read.ts` 读取题目事实，形成单向
  依赖。
- 提交可见性 SQL 政策迁入 `src/modules/access/submission-policy.ts`，题目列表/题单
  读取不再导入 query 服务；题库提交摘要由 access 低层只读政策提供，
  `src/modules/application/read-models/problems.ts` 仅保留给页面组合使用，problems
  业务不反向依赖 read-models。
- 绑定策略切换由 application 在唯一外层 `DbTx` 内调用 problems 写入和 evaluations
  投影重算；跨事务调用提供显式必填的 `setDomainProblemBindingPolicyCommandTx`。
- 题目删除由 `deleteProblemTx` 提供本地必填 `DbTx`，application 在同一外层事务内
  登记 evaluations projection revision，提交后才执行对象、审计和搜索通知。
- 域题号分配与 `domain_resource_counters` 更新改走 access 的必填 `DbTx` 能力，
  题目绑定/创建不再直接写 access-owned 共享表；默认域 backfill 仍是迁移兼容入口。
- problems 版本发布不再调用 search writer 或在事务内构造 search entry；发布后的搜索
  可见性继续由已有事件通道收敛。
- 域题草稿/版本发布、题包替换、OI 文件保存、题单与共享策略、标签管理的 HTTP 写入
  已接入 `src/modules/application/problems.ts`，入口统一由认证结果构造
  `UserActor`；域编辑、题包服务、OI 数据授权与题目草稿/预检/统计路由的授权复核也
  改为显式 actor。CRUD 另提供 `createProblemForActor`、`createDomainProblemForActor`、
  `updateProblemForActor` 窄入口，application 不再把裸 userId 传入旧 CRUD 兼容签名。
- 默认竞赛提交路由不再直接调用旧 submission 服务：代码、artifact/prediction 提交和
  客观题提交先由 `src/modules/application/evaluations.ts` 组合题目版本、比赛准入和
  访问快照，再交给 evaluations 受理；竞赛提交历史与客观题历史/详情也通过显式
  `UserActor` 的 application 读取入口完成。支持包删除的草稿引用与迁移期投影在同一
  application `DbTx` 内修改，物理对象回收在提交后执行。
- `src/modules/problems/index.ts` 与 `src/modules/contests/index.ts` 改为逐项显式
  re-export，避免把 worker、迁移回填或测试重置函数泄露到生产门面；回填与测试重置
  调用方改为直接引用其专用路径。

## Alternatives considered

- 保留 problems → contests 的 readonly contract 依赖：拒绝，因为名称改变不能消除运行时
  双向边。
- 在 problems 服务增加可选 callback 让调用方补投影：拒绝，因为调用方可以省略 callback，
  从而破坏策略、版本和投影的一致提交。
- 让业务服务继续直接调用 query/search/submission：拒绝，因为这些是外部 read-model 或
  评测副作用，必须由 access/application 编排。

## Consequences

- `src/modules/contests/contracts/read.ts` 现在只是旧 userId 调用方的窄兼容适配；新
  problems 代码直接消费 access 政策。
- 旧的直接调用方仍需在后续迁移中切换到 application command；正式测试已将策略即时重算
  与事务回滚路径切换到显式 actor/Tx 入口。
- direct-write 候选中的 evaluations-owned 提交/self-test 清理、access-owned 域计数器、
  assets-owned storage object 引用与 platform-owned audit 仍需对应 owner 提供窄
  `DbTx` 合同；本批已把题目清理与 evaluations revision 放进同一外层事务，但旧清理
  仍直接触及 evaluations-owned 行，尚未把这些表的删除实现迁入对应 owner。
- `problems` 的旧整题包服务、CRUD、支持包和客观题读取兼容函数仍保留历史
  Context/role/可选 userId 签名供旧测试/CLI 使用；HTTP 路由已切到显式
  UserActor/application 命令。严格收口前还需把这些兼容调用方迁完并移除缺失用户的
  `ROOT_USER_ID` 兜底。发布事务中的 assets-owned storage object 哈希补写、
  platform-owned audit，以及 evaluations-owned 提交/self-test 清理仍等待对应 owner
  提供窄 `DbTx` 合同。
- 平台路径恢复后，按正式 `deno task test:domain` 在隔离 PG/Redis 上重新验收：contests
  的运行中参赛者准入、赛后保密失效、固定版本/缺省版本冲突各通过 1/0；problems 的
  草稿 revision 负例、绑定事务回滚和默认域权限撤销各通过 1/0。固定版本首次回归发现
  application admission 将版本冲突当普通 `Error` 返回 500，已在 evaluations read
  contract 恢复 409 `CONTEST_PROBLEM_VERSION_CHANGED` 及版本元数据后重跑通过；门面显式
  导出改动后再次用正式 launcher 验证 problems 草稿 revision 与 contests 固定版本冲突，
  均为 1 passed / 0 failed。
- 门禁复核（结构元数据不改）：`check-module-boundaries --json` 当前全局仍有 5 个
  历史 SCC / 164 条遗留诊断，但 problems、contests、application 的非 facade 违规为
  0，且两业务模块之间没有运行时直接边；本批没有修改 launcher、metadata 或 root
  `deno.json`。

