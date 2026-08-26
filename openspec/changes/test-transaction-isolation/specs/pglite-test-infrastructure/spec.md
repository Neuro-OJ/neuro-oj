## MODIFIED Requirements

### Requirement: 测试数据库重置

系统 SHALL 提供 `resetDbForTest()` 函数，清空数据库所有表数据并重新插入必需种子数据（root 用户、judge image），使测试文件获得干净的数据库状态。

在 PGlite 模式下，`resetDbForTest()` SHALL 基于已加载模板的实例执行 `TRUNCATE ... CASCADE` + 轻量 re-seed，不再重复执行 schema DDL。

在 postgres.js 模式下，`resetDbForTest()` SHALL 复用现有连接池执行 `TRUNCATE ... CASCADE` + re-seed，不再关闭/重建连接池。

系统 SHALL 将 RBAC 重播种和物化视图刷新从默认 reset 路径中弱化：保留种子参考表，物化视图按需刷新。

在测试事务内（active 或 pending），`resetDbForTest()` SHALL 直接返回，不执行 `TRUNCATE` 和重新 seed。

#### Scenario: 模块级 PGlite 重置数据库

- **WHEN** `resetDbForTest()` 在 PGlite 模式且不在测试事务内被调用
- **THEN** 所有表数据被清空，root 用户和 judge image 被重新插入，schema 不重建

#### Scenario: 模块级 PG 重置复用连接池

- **WHEN** `resetDbForTest()` 在 postgres.js 模式且不在测试事务内被调用
- **THEN** 连接池不被关闭，`TRUNCATE` + re-seed 在同一连接池上完成

#### Scenario: 测试事务内 reset no-op

- **WHEN** `resetDbForTest()` 在测试事务内被调用
- **THEN** 函数直接返回，不执行 `TRUNCATE` 和重新 seed

#### Scenario: RBAC 种子表默认保留

- **WHEN** 普通测试在模块级调用 `resetDbForTest()`
- **THEN** 角色/权限等种子参考表不被清空，避免每次全量重播

#### Scenario: 物化视图按需刷新

- **WHEN** 非排名相关测试调用 `resetDbForTest()`
- **THEN** 不执行 `user_rankings` 物化视图刷新；排名相关测试显式触发刷新
