## ADDED Requirements

### Requirement: PGlite 模板加载

系统 SHALL 在 PGlite 模式下通过 `loadDataDir` 加载预构建模板，模板包含 schema 和基础种子；模板缺失或过期时 SHALL 自动重建或回退到原有 DDL 引导。

#### Scenario: 模板存在时加载模板

- **WHEN** `getDb()` 在 PGlite 模式被调用且模板缓存存在
- **THEN** 系统创建 PGlite 实例并加载模板，不重复执行 DDL

#### Scenario: 模板缺失时回退或重建

- **WHEN** 模板不存在或 hash 不匹配
- **THEN** 系统重建模板后加载，或回退到原有 DDL 引导逻辑

## MODIFIED Requirements

### Requirement: 测试数据库重置

系统 SHALL 提供 `resetDbForTest()` 函数，清空数据库所有表数据并重新插入必需种子数据（root 用户、judge image），使测试文件获得干净的数据库状态。

在 PGlite 模式下，`resetDbForTest()` SHALL 基于已加载模板的实例执行 `TRUNCATE ... CASCADE` + 轻量 re-seed，不再重复执行 schema DDL。

在 postgres.js 模式下，`resetDbForTest()` SHALL 复用现有连接池执行 `TRUNCATE ... CASCADE` + re-seed，不再关闭/重建连接池。

系统 SHALL 将 RBAC 重播种和物化视图刷新从默认 reset 路径中弱化：保留种子参考表，物化视图按需刷新。

#### Scenario: PGlite 模式下重置数据库

- **WHEN** `resetDbForTest()` 在 PGlite 模式被调用
- **THEN** 所有表数据被清空，root 用户和 judge image 被重新插入，schema 不重建

#### Scenario: PG 模式下重置复用连接池

- **WHEN** `resetDbForTest()` 在 postgres.js 模式被调用
- **THEN** 连接池不被关闭，`TRUNCATE` + re-seed 在同一连接池上完成

#### Scenario: RBAC 种子表默认保留

- **WHEN** 普通测试调用 `resetDbForTest()`
- **THEN** 角色/权限等种子参考表不被清空，避免每次全量重播

#### Scenario: 物化视图按需刷新

- **WHEN** 非排名相关测试调用 `resetDbForTest()`
- **THEN** 不执行 `user_rankings` 物化视图刷新；排名相关测试显式触发刷新
