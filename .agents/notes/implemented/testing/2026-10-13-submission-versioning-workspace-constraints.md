# Agent Note: 版本化执行夹具显式满足工作空间约束

Status: implemented

## Problem

执行归属收缩迁移将普通提交、客观题、自测的 domain 与题库绑定设为 NOT NULL，
批任务和条目的 domain 同样必填，只有 failed/skipped 条目允许缺少绑定。 旧
versioning 夹具直接插入题目主键与版本，依赖稍后的旧测试门面回填，
不再符合写入时应满足的数据库约束。

同步生成批量记录和交叉竞赛提交的代码不能直接加入异步绑定查询。 5200
条条目插入测试还只写了 ja-p6 题目主键，没有建立实际源题。

## Decision

逐份检查 versioning 目录的实际插入点，在单条普通提交、客观题及任务条目创建前，
显式调用共享 `problemExecutionForTest(problemId)`，取得实际源域与 owned 绑定。
该 helper 只建立指定源题的绑定，不授予角色、不回填其他提交，也不猜测使用域。
手写 main 任务明确填写 DEFAULT_DOMAIN_ID，与本文件实际受理上下文保持一致。

批量受理测试先取得 ja-p5 的执行上下文，再构造各行；5200 条插入测试先建立 ja-p6
真实题目、版本与绑定，再复用该题上下文生成记录。
交叉竞赛的四道题分别异步读取执行上下文后构造提交，保持各自竞赛关系。

共修改十三份 DB 夹具文件。纯 producer-errors
分类测试没有持久执行记录，保持原样。 已有真实 PostgreSQL
屏障、源删除、租约、SKIP LOCKED、配额、版本与终态吊销断言
保留，没有删断言、增加失败跳过或放宽访问权限。
没有修改生产服务、Schema、迁移、共享 helper 或其他 submission 测试目录。

## Alternatives considered

- 在所有 insert 中自动补 main
  与随机绑定：会掩盖错误归属，按每道真实源题显式取得。
- 继续等待受理门面统一回填：NOT NULL
  与复合外键要求初始写入已经正确，不依赖后续修补。
- 给整个测试集合批量授权或修改共享 helper 自动回填提交：会改变权限测试含义，
  只在本文件需要的位置调用无权限副作用的源题 helper。
- 5200 条测试使用不存在题目或给 pending
  条目留空绑定：不符合当前约束，建立真实宿主。

## Consequences

2026-10-13 使用标准 `deno task test:domain submission`，通过 Deno 的 目录 ignore
参数仅排除由另一批维护的 services/routes/mq/types，执行全部十四份 versioning
测试，标准迁移与种子步骤保持不变。

0137 在独立 PostgreSQL 回归库和 client_versioning_nn_1 schema 应用后， 该目录为
62 passed、0 failed，耗时 31 秒。相同目录的 PGlite 为 48 passed、0 failed、14
ignored，耗时 18 秒；忽略项是原先明确需要真实 PostgreSQL
的锁、屏障与独立清理检查，不记为 PGlite 并发通过。

十四份文件通过 deno check、格式与 lint，本记录通过 Agent Note 校验。
这份记录只确认版本化夹具目录，全 submission 与 core 集成结果由所有夹具批次冻结后
统一验证，不将本次目录检查冒充全模块验收。
