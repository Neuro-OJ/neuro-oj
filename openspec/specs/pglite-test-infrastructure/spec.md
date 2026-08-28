## Purpose

定义 Neuro OJ 在无外部 PostgreSQL 环境时使用 PGlite（PostgreSQL WASM）内存数据库进行测试的基础设施规范。使开发者无需启动 Docker 即可运行单元测试。

## Requirements

### Requirement: PGlite 内存数据库工厂

系统 SHALL 在 `DATABASE_URL` 环境变量未设置时，使用 `@electric-sql/pglite` 在内存中创建嵌入式 PostgreSQL 数据库实例。

该实例 MUST 支持以下 PostgreSQL 特性：

- 标准 DML/DDL（CREATE TABLE, INSERT, SELECT, UPDATE, DELETE）
- `RETURNING` 子句
- `ON CONFLICT DO NOTHING` 和 `ON CONFLICT DO UPDATE`
- `ILIKE` 模糊匹配
- `FILTER (WHERE ...)` 聚合子句
- `CHECK` 约束
- `UNIQUE` 复合约束和 `UNIQUE` 索引
- `PRIMARY KEY` 和 `FOREIGN KEY` 约束（含 `ON DELETE CASCADE` / `ON DELETE SET NULL`）
- ACID 事务（含 `BEGIN`/`COMMIT`/`ROLLBACK`，`db.transaction()` API）
- `||` 字符串拼接和 `CAST(... AS TEXT)` 类型转换
- `now()` 和 ISO 8601 时间戳

#### Scenario: 无 DATABASE_URL 时自动使用 PGlite

- **WHEN** `getDb()` 被调用且 `DATABASE_URL` 环境变量未设置
- **THEN** 系统创建 PGlite 内存数据库实例并返回 Drizzle ORM 客户端

#### Scenario: 有 DATABASE_URL 时使用外部 PostgreSQL

- **WHEN** `getDb()` 被调用且 `DATABASE_URL` 环境变量已设置
- **THEN** 系统使用 postgres.js 驱动连接外部 PostgreSQL（现有行为不变）

### Requirement: PGlite 模板加载

系统 SHALL 在 PGlite 模式下通过 `loadDataDir` 加载预构建模板，模板包含 schema 和基础种子；模板缺失或过期时 SHALL 自动重建或回退到原有 DDL 引导。

#### Scenario: 模板存在时加载模板

- **WHEN** `getDb()` 在 PGlite 模式被调用且模板缓存存在
- **THEN** 系统创建 PGlite 实例并加载模板，不重复执行 DDL

#### Scenario: 模板缺失时回退或重建

- **WHEN** 模板不存在或 hash 不匹配
- **THEN** 系统重建模板后加载，或回退到原有 DDL 引导逻辑

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

### Requirement: 测试 Schema 引导

系统 SHALL 在 `tests/` 下提供 `setupSchemaForTest()` 函数，在 PGlite 内存数据库中执行 DDL 创建所有表、索引和约束。

该函数 MUST：

- 创建与 `drizzle/` 迁移文件一致的 11 张表及所有索引和约束
- 插入必需的基础种子数据（root 用户 UID=0 + judge image）
- 幂等：可重复执行而不报错（使用 `IF NOT EXISTS`）

#### Scenario: 首次执行 schema 引导

- **WHEN** `setupSchemaForTest()` 在空白 PGlite 数据库上首次执行
- **THEN** 所有表、索引、约束被创建，root 用户和评测镜像被插入

#### Scenario: 重复执行 schema 引导

- **WHEN** `setupSchemaForTest()` 在已有 schema 的数据库上再次执行
- **THEN** 操作完成，不抛出表已存在错误

#### Scenario: postgres.js 模式下跳过

- **WHEN** `setupSchemaForTest()` 在 postgres.js 模式下被调用（`DATABASE_URL` 已设置）
- **THEN** 函数直接返回，不做任何操作（由 `00_migrate_test.ts` 的文件迁移处理）

### Requirement: 测试之间数据库隔离

系统 SHALL 允许每个测试文件通过调用 `resetDbForTest()` 获得独立的干净数据库状态。

测试文件 MAY 通过在 `Deno.test` 之前调用 `resetDbForTest()` 实现 per-test 隔离。

#### Scenario: 测试文件 A 创建的数据对测试文件 B 不可见

- **WHEN** 测试文件 A 调用 `resetDbForTest()` 后插入数据
- **THEN** 测试文件 B 调用 `resetDbForTest()` 后无法看到这些数据（TRUNCATE 清空所有表）

#### Scenario: 现有测试代码无需修改

- **WHEN** 现有测试使用 `getDb()` 和 `resetDbForTest()` 的代码在 PGlite 模式下运行
- **THEN** 测试行为与 postgres.js 模式下一致：`resetDbForTest()` 重置数据库状态，业务代码通过 `getDb()` 获取数据库客户端
