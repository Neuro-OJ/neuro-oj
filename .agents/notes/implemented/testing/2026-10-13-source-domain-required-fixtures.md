# Agent Note: 必填源域的测试夹具与统一初始化

Status: implemented

## Problem

题目与题单所属 Domain 收紧为非空后，旧测试仍直接插入没有 domain_id 的资源。
过去由 NULL 表示默认域的测试输入不再符合新写入约束，缺少默认域基础数据也会造成
外键失败。仅在迁移测试进程初始化默认域不足以覆盖独立的 domain 测试进程。

## Decision

- 所有受影响的直接数据库题目或题单夹具明确保存默认 main 的稳定 ID；已有自然
  目标域的夹具继续使用其原域，不将多域用例归并成 main。
- 标准测试 preload 导入测试层初始化模块，后者通过现有 registerDbResetSeeder 注册
  ensureDefaultWorkspace。reset 后建立完整真实默认域、角色与容量记录，
  不逐对象查询授权，不在生产 Schema 增加默认 domain_id。
- PostgreSQL 的 00 迁移初始化在 Root/RBAC 之后显式初始化默认工作空间。 不修改
  production connection，也不让 shared 基础层反向导入业务模块。
- 原 NULL 回填用例改为合法 main 来源题的 owned binding 补齐与幂等验证；归属
  已保存，因此 assigned 计数为 0，仍覆盖保留 ID、版本、题号和原策略、不覆盖
  修改后绑定策略。真实未归域存量回填由 root 的备份恢复迁移演练验证。
- 历史迁移用例构造的是迁移前 Schema，保留它的旧分类和 NULL 输入，不使用类型
  断言让新 Schema 接受不可能的写入。

## Alternatives considered

- 为生产 domain_id 设置 main
  默认值：会把遗漏归属的业务写入静默变成公共域，拒绝。
- 每个测试题目创建前调用
  loadWorkspace：重复授权查询，不适合基础数据夹具，不采用。
- 在 shared connection 中导入工作空间初始化：违反模块依赖边界，不采用。
- 仅在 tests/00_migrate_test.ts 注册 seeder：迁移与实际 domain
  测试属于不同进程， 无法覆盖后者的 reset，因此通过标准 preload 注册。
- 继续写 NULL 并绕过类型检查：不符合新的数据库约束，拒绝。

## Consequences

测试数据显式表达使用域，初始化复用正式默认域基础数据，不增加生产兜底。
Domain、共享、版本与配额规则的实际回归仍按标准域命令执行。

验证通过：全 core `deno task check:types`；84 个修改测试文件 fmt/lint；catalog
标准 PGlite 与 PostgreSQL 各 364 passed / 0 failed；workspace 标准 PGlite 42
passed / 0 failed / 8 ignored，PostgreSQL 50 passed / 0 failed。 PostgreSQL
使用隔离 schemas test_catalog_domain_notnull_oct13 与
test_workspace_domain_notnull_oct13。忽略项为仅真实 PostgreSQL
可运行的并发测试， 它们已在 PostgreSQL 本轮执行。本记录不代替 root
的恢复迁移、全量跨模块或浏览器 验收。
