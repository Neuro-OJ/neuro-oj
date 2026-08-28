## Purpose

定义 noj-core 测试用例自动事务包装与隔离规范，通过 Deno `--preload` 全局包装 `Deno.test`，使每个测试用例在事务中执行并统一回滚。

## Requirements

### Requirement: 测试用例自动事务包装

系统 SHALL 通过 Deno `--preload` 全局包装 `Deno.test`，使每个测试用例在事务中执行，并在用例结束后统一回滚。

#### Scenario: DB 测试用例自动回滚

- **WHEN** 一个使用数据库的测试用例执行完成
- **THEN** 用例内写入的数据被自动回滚，数据库恢复用例开始前的状态

#### Scenario: 纯单元测试不开启事务

- **WHEN** 一个不调用 `getDb()` 的纯单元测试执行
- **THEN** 不创建数据库事务，也不产生数据库初始化开销

### Requirement: 惰性事务开启

系统 SHALL 在 `beginTestTransaction()` 时只设置 pending 标记，首次调用 `getDb()` 时才真正开启数据库事务。

#### Scenario: 首次 getDb 开启事务

- **WHEN** 测试用例内第一次调用 `getDb()`
- **THEN** 系统开启事务并返回事务内数据库客户端

#### Scenario: 未调用 getDb 不连库

- **WHEN** 测试用例全程未调用 `getDb()`
- **THEN** 系统不连接数据库，`rollbackTestTransaction()` 只清理 pending 标记

### Requirement: 嵌套事务 Savepoint 兼容

系统 SHALL 在测试事务内将 `db.transaction()` 转换为 `SAVEPOINT / RELEASE / ROLLBACK TO`，以兼容服务层嵌套事务调用。

#### Scenario: 服务层嵌套事务成功

- **WHEN** 测试事务内服务调用 `db.transaction()` 且回调成功
- **THEN** 内层通过 savepoint 提交，外层最终 ROLLBACK 时所有数据回滚

#### Scenario: 服务层嵌套事务失败

- **WHEN** 测试事务内服务调用 `db.transaction()` 且回调抛错
- **THEN** 内层回滚到 savepoint，错误继续向外抛出，外层最终 ROLLBACK

### Requirement: 用例内 resetDbForTest no-op

系统 SHALL 在 active 或 pending 测试事务内调用 `resetDbForTest()` 时直接返回，不执行 `TRUNCATE` 和重新 seed。

#### Scenario: 事务内 reset 不清理

- **WHEN** 测试用例内调用 `resetDbForTest()`
- **THEN** 函数直接返回，数据仍由事务回滚保证隔离

#### Scenario: 模块级 reset 保持有效

- **WHEN** 测试文件模块顶层调用 `resetDbForTest()`
- **THEN** 仍执行原有清空与种子逻辑，建立文件初始状态

### Requirement: 文件级 opt-out

系统 SHALL 提供 `disableTestTransactionForFile()`，供存在跨用例数据依赖的测试文件关闭事务包装。

#### Scenario: 关闭后使用原 reset 行为

- **WHEN** 测试文件调用 `disableTestTransactionForFile()`
- **THEN** 该文件所有用例不进入事务包装，继续使用原有 `resetDbForTest()` 行为
