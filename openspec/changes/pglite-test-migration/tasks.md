## 1. 依赖与基础设施

- [ ] 1.1 在 `deno.json` 中添加 `@electric-sql/pglite` npm 依赖
- [ ] 1.2 创建 `tests/_setup.ts`：导出 DDL SQL 字符串（13 张表 + 8 索引，从 Drizzle schema 翻译）和种子数据 SQL（root 用户 + judge image）

## 2. 核心：双模式数据库连接 + 重置

- [ ] 2.1 修改 `src/db/connection.ts`：`getDb()` 在无 `DATABASE_URL` 时创建**全局单例** PGlite 实例 + `drizzle(client, { schema })` 客户端；有 `DATABASE_URL` 时保持 postgres.js 行为不变
- [ ] 2.2 修改 `src/db/connection.ts`：`resetDbForTest()` 在 PGlite 模式下执行 `TRUNCATE ... CASCADE` + re-seed（而非关闭实例）
- [ ] 2.3 修改 `src/db/connection.ts`：`checkDbHealth()` 适配 PGlite 模式
- [ ] 2.4 修改 `src/services/problems.ts`：PG 错误码 23505 检查兼容 `err.code` 和 `err.cause.code` 两种结构

## 3. 测试基础设施

- [ ] 3.1 创建 `tests/_setup.ts` 的 `setupSchemaForTest()` 函数：PGlite 模式下执行 DDL + 种子数据（幂等, 使用 `IF NOT EXISTS` + `ON CONFLICT DO NOTHING`），PG 模式下 no-op
- [ ] 3.2 修改 `tests/00_migrate_test.ts`：PGlite 模式下调用 `setupSchemaForTest()` 替代 `runMigrations()`；PG 模式下保持现有行为；`DATABASE_URL` 未设置时不再跳过
- [ ] 3.3 修改 `tests/services/auth.test.ts`：将 `registerUser(TEST_USER)` 从 test 1 移到模块级 setup，消除对测试执行顺序的依赖
- [ ] 3.4 修改 `tests/services/problems.test.ts`：将 `createProblem(...)` 从 test 1 移到模块级 setup，消除对 `TEST_PROBLEM_ID` 顺序赋值的依赖
- [ ] 3.5 修改 `tests/routes/problems.test.ts`：将测试数据插入从第一个测试移到模块级 setup

## 4. 验证

- [ ] 4.1 运行 `deno task test`（无 `DATABASE_URL`）— 所有 30 个 DB 依赖测试通过
- [ ] 4.2 运行 `deno task test`（有 `DATABASE_URL`）— 现有 PG 路径测试仍通过
- [ ] 4.3 验证 `resetDbForTest()` TRUNCATE 生效：测试 A 插入数据后 `resetDbForTest()`，测试 B 看到空白数据库

## 5. CI 优化（可选）

- [ ] 5.1 更新 `.github/workflows/ci.yml` core-test job：移除 PostgreSQL 服务依赖（Redis 保留用于 MQ 测试）
