# Agent Note: 工作空间验收测试的真实环境门控

Status: implemented

## Problem

工作空间升级新增多连接并发、持久账本、性能和完整栈旅程。默认单元运行不能执行这些外部环境测试；原静默跳过基线没有记录新用例。只提高基线而不实际运行，会让关键隔离及故障恢复失去验证。

## Decision

仅为真实环境条件保留门控，并通过官方报告脚本重新登记位置：

- workspace 成员／存储和 education 新生分配、评测任务并发测试依赖真正 PostgreSQL
  多连接。标准 core PostgreSQL 运行已执行；PGlite 分支不宣称数据库锁竞争验收。
- 100 人 × 50 题矩阵与 outbox 性能需要显式 `NOJ_RUN_PERF`、独立 PostgreSQL
  和允许目标库；已记录固定场景的真实测量，不在普通单元流程混入性能结论。
- Gateway 域 Provider、配置 CAS、额度和持久结算测试需要
  PostgreSQL／Redis。集成实际运行完整 127 项；CI Gateway job 增加 PostgreSQL
  服务，设置两个专用测试 URL，并通过标准 `deno task test --frozen`
  执行。不能只运行节流 Redis 用例而忽略域持久约束。
- Public／Private／Mixed、教学与域治理浏览器测试需要真实 UI、API、Judge 与
  Chromium。标准 Browser job 已设置
  `NOJ_RUN_BROWSER_E2E=1`；本机已实际执行旅程，治理另有 7
  步。新用例采用同样的既有门控。
- 五赛制 Native、40 × 5 全题型作业、education outbox
  重启测试依赖真实评测栈。标准 E2E 的 `NOJ_RUN_E2E` 与 Native
  资源池条件继续生效；已经实际运行并记录
  Judge、真实受理时间与持久事件，不通过写入假成绩完成验收。

新增门控没有用于屏蔽执行后的失败。合并后出现的迁移排序、旧夹具和 DTO
不符均修复并重新执行受影响范围。

## Alternatives considered

- 删除环境条件，使缺外部服务的单元环境失败：并不能提供 PostgreSQL 锁、Docker
  或浏览器证据。
- 把多连接／真实栈测试改成 mock：丢失本次需要的隔离、预算与恢复验证。
- 只提高数量基线：不记录环境和实际执行，无法 review，不采用。

## Consequences

报告及 JSON 基线由 `deno run -A scripts/silent-skip-report.ts --update-baseline`
自动生成；新增位置受后续棘轮检查。已有真实测试日志与各专题 Agent Note
保留证据。性能测试采用专门验收环境，外部付费 LLM API
仍需独立凭据，其忽略不代表付费上游可用。

本记录说明门控与 CI 执行入口，不代表最终集成 CI 或生产镜像已完成验收。

最终本地仓库门禁通过：扫描 666 个测试文件，基线 1096 处。新增教学写频率 两项
Redis 条件在 PostgreSQL／PGlite 标准入口均实际执行；新增域模型治理、
预测／界面题和 40 人 CSV／矩阵／交接浏览器各自实际执行并通过。 完整跨模块 55
项、零忽略。原 20 项浏览器的完整运行通过 17 项，另外 3 项修复
夹具前置操作后补验通过；新班级旅程另有 1 项、6 步通过。 `noj-tests/deno.lock` 的
PostgreSQL 测试依赖由 Deno 自动生成，用于读取真实
受理尝试和域模型冻结依据，没有手动改写锁文件。
