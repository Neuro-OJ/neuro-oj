## Context

当前 noj-core 使用 PostgreSQL 作为唯一数据库。测试通过 `DATABASE_URL` 环境变量指定一个外部 PG 实例，测试之间共享该实例，无隔离机制。Drizzle ORM 通过 `drizzle-orm/postgres-js` 驱动连接 PostgreSQL，schema 定义使用 `drizzle-orm/pg-core`。

PGlite (`@electric-sql/pglite`) 是 PostgreSQL 编译到 WebAssembly 的嵌入式实现，支持：
- 与 `drizzle-orm/pglite` 驱动（使用 `pg-core` 的同一套 schema 定义）
- `ILIKE`、`RETURNING`、`ON CONFLICT`、`FILTER(WHERE)`、`||`、`CAST` 等 PG 语法
- 完整 ACID 事务
- 错误码与 PostgreSQL 一致（嵌套在 `cause` 属性下）

原型测试已验证所有关键特性在 Deno 2.9 + PGlite 0.5.3 + Drizzle ORM 0.45.2 下均正常工作。

性能数据（500 次采样）：
- `new PGlite()` 冷启动（WASM 加载 + PG init）：~1000ms
- 完整 Schema DDL（13 表 + 8 索引 + 种子）：~3.4s（含一次 `new PGlite()` 后执行）
- `TRUNCATE CASCADE` + re-seed：~18ms
- 典型单条查询：~0.22ms（vs postgres.js ~0.11ms，约 2x 慢但绝对值 < 0.2ms）

## Goals / Non-Goals

**Goals:**
- 消除测试对 `DATABASE_URL`/外部 PostgreSQL 的强制依赖
- 提供测试隔离：每个测试文件（或每个测试）可拥有独立的数据库实例
- `getDb()` 和 `resetDbForTest()` 接口保持不变，所有测试代码零修改
- 兼容两种 PG 错误对象结构（postgres.js 的 `err.code` 与 PGlite 的 `err.cause.code`）

**Non-Goals:**
- 不替换生产环境的 PostgreSQL（`DENO_ENV=production` 时始终使用 postgres.js）
- 不修改已有的 Drizzle migration 文件和迁移流程
- 不涉及 MQ/Redis 相关的测试基础设施变更
- 不修改测试的业务逻辑或断言

## Decisions

### Decision 1: 环境变量驱动的双模式连接

`getDb()` 在检测到 `DATABASE_URL` 时使用现有 postgres.js 路径（生产/CI）；未检测到时使用 PGlite 路径（测试）。

**替代方案考虑：**
- 硬编码 `NOJ_ENV=test` 标志 → 增加了与现有 `NOJ_ENV` 语义的耦合，且 CI 中仍需 PG
- 单独测试入口文件 → 维护两份 `connection.ts`，容易 drift

**选择理由**：`DATABASE_URL` 存在 = 用外部 PG，不存在 = 用内存 PG。最大程度向后兼容，CI 配置无需变更。

### Decision 2: 单 PGlite 实例 + `resetDbForTest()` = TRUNCATE 重置

`new PGlite()` 冷启动耗时约 **1000ms**，不能在每次 `resetDbForTest()` 时创建新实例。
改为**全局单 PGlite 实例**，`resetDbForTest()` 做 `TRUNCATE ... CASCADE` + re-seed（耗时 ~18ms）。

```typescript
// PGlite 模式下 resetDbForTest() 的行为
await client.query('TRUNCATE TABLE users, problems, submissions, ... CASCADE');
await client.query('INSERT INTO users ...');   // re-seed root user
await client.query('INSERT INTO judge_images ...');  // re-seed judge image
```

**为什么不是事务回滚：**
- 测试中可能调用 `db.transaction()`（如 `saveEvaluationResult`），嵌套事务语义复杂
- Deno 没有 `beforeEach`/`afterEach` 钩子，做不到自动包裹事务界限
- TRUNCATE ~18ms 足够快，且不受事务嵌套影响

### Decision 3: Schema 引导——Drizzle 原生 DDL 替代迁移文件

PGlite 下不使用 `drizzle-orm/postgres-js/migrator`（它需要 postgres.js 驱动和特定路径的文件读取）。改为在 `tests/` 下提供 `setupSchemaForTest()` 函数，通过 Drizzle schema 定义的对象信息 + `db.execute(sql`CREATE...) ` 生成表结构。

实际实现思路：
- 从模块中导出 `PG_SCHEMA_SQL`，这是一份纯 SQL 的 DDL（手动维护或自动生成，约 50 行），在 PGlite 模式下直接 `db.execute(PG_SCHEMA_SQL)`
- 简化维护：Schema 有变更时需同步更新这行 SQL — 但变更频率极低（上一个 schema 变更距今数月）

**替代方案考虑：**
- `drizzle-kit push` → 需额外工具链 + 文件系统依赖，太重
- 自动从 `drizzle/**/*.sql` 读取并执行 → 可行但 PG 迁移文件包含特定语句，PGlite 下逐文件执行更脆弱

### Decision 4: 模块级 setup 替代顺序依赖

现有 3 个测试文件（`tests/services/auth.test.ts`、`tests/services/problems.test.ts`、`tests/routes/problems.test.ts`）存在"先创建数据、后面的测试依赖这些数据"的顺序依赖。在 `resetDbForTest()` 改为 TRUNCATE 后，这些测试会断。

改为**模块级（module-level）setup** 模式——在文件顶层（`Deno.test` 之外）执行共享数据的初始化：

```typescript
// 模块级——在任何 Deno.test 之前执行一次
await resetDbForTest();  // PGlite: TRUNCATE all + schema + seeds
await registerUser(TEST_USER);  // 显式创建共享数据

Deno.test({ name: "test 1", fn: async () => {
  // TEST_USER 已经在模块级创建了
  await assertRejects(() => registerUser(TEST_USER), ConflictError);
}});
```

这样 `resetDbForTest()` 在每个测试开头调用时能真正清理状态（~18ms），而模块级代码确保数据在文件内共享可用。

**无需修改的测试文件**（30 个中的 ~27 个）：每个测试已经自己创建测试数据，不存在跨测试依赖，`resetDbForTest()` TRUNCATE 后各自创建数据即可。

### Decision 5: 错误码兼容

`problems.ts:514-516` 处 PG 23505 检查改为：

```typescript
const pgCode = (err as Record<string,unknown>)?.code || (err as Record<string,unknown>)?.cause?.code;
if (pgCode === "23505") { ... }
```

这样同时支持 postgres.js（`err.code`）和 PGlite（`err.cause.code`）。

## Risks / Trade-offs

- **Schema DDL 维护**：新增表/列时需同步更新 DDL SQL 字符串 → 风险低，schema 变更极少且 CI 可通过 `DATABASE_URL` 模式检测
- **PGlite 功能边界**：未来使用 PGlite 不支持的 PG 扩展（如 `pgvector`、`PostGIS`）时需回退 → 目前无此需求，可通过设置 `DATABASE_URL` 随时切回外部 PG
- **WASM 冷启动**：首次 `new PGlite()` + schema DDL 约 **3.4s** → 一次性的，后续 TRUNCATE 仅 ~18ms，总测试时间约 4s，与当前相当
- **单查询 ~0.22ms vs postgres.js ~0.11ms**：PGlite 因 WASM 边界开销约 2x 慢，但绝对值差 < 0.2ms，总测试时间差可忽略
- **错误对象结构差异**：PGlite 的 `cause` 嵌套可能在未来版本中变更 → 兼容检查已覆盖两层，适应变化
- **Deno npm 兼容层**：PGlite 在 Deno 下通过 `npm:` 协议加载，WASM 文件从 registry 下载缓存后有冷启动延迟 → 已通过 `deno.lock` 锁定版本

## Migration Plan

1. **Phase 1（本次变更）**
   - 修改 `connection.ts` 支持 PGlite 模式
   - 修改 `problems.ts` 错误码检查
   - 修改 `00_migrate_test.ts` 使用 schema SQL 替代文件迁移
   - 更新 `deno.json` 依赖
   - 所有测试通过（无 DATABASE_URL 时）

2. **Phase 2（可选后续优化）**
   - CI 移除 PostgreSQL 服务（`ci.yml`）
   - per-test 隔离升级
   - 性能对比基线

3. **Rollback**：设置 `DATABASE_URL` 环境变量即可切回旧行为（无代码回滚需要）

## Open Questions

- 是否需要在 `seed.ts` 中也暴露 PGlite 模式给开发者本地使用？（当前 scope：仅测试）
- CI 是否需要保留一个 PG 依赖的测试矩阵来验证 postgres.js 兼容性？（建议保留，但默认 job 用 PGlite）
