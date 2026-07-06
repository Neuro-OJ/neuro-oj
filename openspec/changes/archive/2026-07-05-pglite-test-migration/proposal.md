## Why

当前 noj-core 的 23 个 DB 依赖测试必须连接外部 PostgreSQL（通过 `DATABASE_URL` 环境变量），缺乏该环境变量则全部跳过。测试之间无隔离机制——多个测试文件共享同一数据库实例，通过 `Date.now()` 生成唯一 ID 来避免冲突，测试用例之间存在隐性顺序依赖。这导致：(1) 新开发者需要额外配置 Docker/PostgreSQL 才能跑测试；(2) CI 环境必须启动 PostgreSQL 和 Redis 服务；(3) 测试不可独立运行，调试困难。

PGlite（PostgreSQL WASM）能将完整 PostgreSQL 嵌入 Deno 进程，在内存中运行，无需外部依赖，同时保留所有 PostgreSQL 语义和 Drizzle ORM API 兼容性。

## What Changes

- **新增** PGlite 测试连接模块：`tests/` 下提供基于 `@electric-sql/pglite` + `drizzle-orm/pglite` 的内存数据库工厂函数，支持每个测试文件独立数据库实例
- **新增** 测试 schema 引导函数：从 Drizzle schema 生成 PGlite 表结构，替代 `drizzle-orm/postgres-js/migrator`（PG 迁移文件无法用于 PGlite）
- **新增** 测试隔离模式：每个测试文件获得独立数据库，或可选每测试独立数据库，消除测试间数据污染
- **修改** 错误码检查逻辑：`problems.ts` 中 `err.code === '23505'` 改为兼容 `err.cause.code`（PGlite 将 PG 错误对象包裹在 `cause` 中）
- **修改** `resetDbForTest()` 行为：从"断开 PG 连接池"改为"销毁旧 PGlite 实例 + 创建新实例"，实现真正的数据重置
- **修改** `deno.json` npm 依赖：新增 `@electric-sql/pglite` 条目
- **移除** `deno task test` 对 `DATABASE_URL` 的硬性依赖（无 DB Uri 的测试全部可运行）
- 路由/服务测试代码本身**不改动**（`resetDbForTest()`、`getDb()` 接口保持不变）

## Capabilities

### New Capabilities

- `pglite-test-infrastructure`: 基于 PGlite 的内存 PostgreSQL 测试基础设施，替代外部 PostgreSQL 依赖，支持独立隔离的测试数据库

### Modified Capabilities

- `database-schema`: PG 错误码检测点适配 PGlite 错误对象结构（`err.code` → 兼容 `err.code` 和 `err.cause.code`）

## Impact

- **Affected code**: `src/db/connection.ts`（PGlite 模式），`src/services/problems.ts`（错误码检查），`deno.json`（npm 依赖），`tests/00_migrate_test.ts`（schema 初始化），所有使用 `getDb()` / `resetDbForTest()` 的测试文件无需改动
- **Dependencies**: 新增 `npm:@electric-sql/pglite@^0.5.3`（~2MB WASM）
- **CI**: 可移除 PostgreSQL 服务启动步骤（`ci.yml` core-test job），但 Redis 仍需保留（MQ 相关测试）
- **Dev UX**: 新开发者 clone 后可直接运行 `deno task test` 获得全部非 MQ 测试反馈，无需 `docker compose up`
