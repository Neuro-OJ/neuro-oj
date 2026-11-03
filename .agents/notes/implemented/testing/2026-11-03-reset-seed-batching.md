# Agent Note: Core 测试 reset 的批量种子与清表策略

Status: implemented

## Problem

`resetDbForTest()` 在模块测试中有 481 个直接调用位置。旧实现逐条写角色/权限/
关联并执行 `TRUNCATE ... CASCADE`；实测单次 reset 中位约 621–645ms，其中
TRUNCATE 占约 519ms（外键闭包 86/99 张表，在 btrfs 上每个关系重建 relfilenode 约
5–9ms），seed 约 105ms。批量写入单独只能降到约 520ms，达不到 50% 目标。

## Decision

- `seed-rbac.ts`：系统角色一次 `values([...])`；全量权限一次批量
  upsert（冲突只同步 description，`setWhere` 跳过未变化行）；user/admin
  默认权限各一次批量 insert； `migrateExistingUsers` 改成单条
  `INSERT ... SELECT ... WHERE NOT EXISTS ...
  ON CONFLICT DO NOTHING`；敏感权限首次撤销一次集合
  `delete`；空数组不发语句。
- `seed-system.ts`：`seedJudgeImages` 三条一次批量 upsert，冲突更新集合仍不含
  `image`，运维手改的镜像名不会被种子覆盖。
- `tests/helpers/db.ts`：筛选 `pg_relation_size > 0` 的表，按 `pg_constraint`
  外键边做 children-first 排序，在一个事务里逐表 `DELETE`；排序失败或执行失败则
  回滚并回退原 `TRUNCATE ... CASCADE`，本进程内不再重试 DELETE；
  `NOJ_TEST_RESET_STRATEGY=truncate` 可强制旧路径。
- reset 的 ownership 检查、真实库名复核、`refreshRankings`
  与系统设置缓存清理保持 原语义；每个阶段用 `measurePhase`
  记录，`core.reset.invocations` 记录次数。

## Alternatives considered

- 只做批量写入：实测 -16%，无法达成目标。
- 统一事务回滚：需要改生产事务边界与单例生命周期，超出测试基础设施范围。
- 每测试独立 schema/数据库：迁移与模板克隆成本更高。
- 保留 TRUNCATE：外键闭包无法缩小，闭包里空表同样要重建 relfilenode。

## Consequences

- 30 次采样中位 34.9ms、P95 40.2ms（旧实现中位 645.4ms、P95 780.7ms），
  中位降低约 94.6%；带榜单刷新中位 55.9ms。
- DELETE 会留下死元组（约 120 行/reset）；临时测试库在 run 结束后删除，长期
  分片内由 autovacuum 回收。若 CI 文件系统上 TRUNCATE 反而更便宜，可保留 env
  开关做 A/B 后调整默认值。
- 外键环导致的回退分支当前 schema 构造不出来，只有 env 强制 TRUNCATE
  的用例覆盖。
