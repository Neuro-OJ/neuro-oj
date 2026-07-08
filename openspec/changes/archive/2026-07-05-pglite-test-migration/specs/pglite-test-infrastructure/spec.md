## ADDED Requirements

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

### Requirement: 测试数据库重置

系统 SHALL 提供 `resetDbForTest()` 函数，关闭当前 PGlite 实例并清空 `getDb()` 的单例缓存，下次 `getDb()` 调用时创建全新空白内存数据库。

在 postgres.js 模式下，`resetDbForTest()` SHALL 保持现有行为（关闭连接池 + 清空单例）。

#### Scenario: PGlite 模式下重置数据库

- **WHEN** `resetDbForTest()` 在 PGlite 模式下被调用
- **THEN** 旧 PGlite 实例被关闭，`_db` 单例清空，下次 `getDb()` 返回绑定到全新空白数据库的客户端

#### Scenario: PG 模式下重置保留现有行为

- **WHEN** `resetDbForTest()` 在 postgres.js 模式下被调用（`DATABASE_URL` 已设置）
- **THEN** 连接池被关闭，`_db` 和 `_client` 清空，与现有行为完全一致

### Requirement: 测试 Schema 引导

系统 SHALL 在 `tests/` 下提供 `setupSchemaForTest()` 函数，在 PGlite 内存数据库中执行 DDL 创建所有表、索引和约束。

该函数 MUST：
- 创建与 `drizzle/` 迁移文件一致的 11 张表及所有索引和约束
- 插入必需的基础种子数据（root 用户 UID=0 + judge image `e0000000-0000-0000-0000-000000000001`）
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

系统 SHALL 允许每个测试文件通过调用 `resetDbForTest()` + `setupSchemaForTest()` 获得独立数据库实例。

测试文件 MAY 通过在每个 `Deno.test` 之前调用 `resetDbForTest()` 实现 per-test 隔离。

#### Scenario: 测试文件 A 创建的数据对测试文件 B 不可见

- **WHEN** 测试文件 A 调用 `resetDbForTest()` + `setupSchemaForTest()` 后插入数据
- **THEN** 测试文件 B 调用 `resetDbForTest()` + `setupSchemaForTest()` 后无法看到这些数据

#### Scenario: 现有测试代码无需修改

- **WHEN** 现有测试使用 `getDb()` 和 `resetDbForTest()` 的代码在 PGlite 模式下运行
- **THEN** 测试行为与 postgres.js 模式下一致：`resetDbForTest()` 重置连接状态，业务代码通过 `getDb()` 获取数据库客户端
