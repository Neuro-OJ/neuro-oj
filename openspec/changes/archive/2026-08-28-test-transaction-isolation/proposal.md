## Why

noj-core 串行测试虽然已经通过 PGlite 模板、bcrypt cost 和 reset 轻量化提速，但每个用例仍执行 `TRUNCATE + re-seed`（全树约 259 次），是剩余的主要耗时来源。事务回滚级隔离可以让用例内 reset 变为 no-op，进一步显著降低测试耗时。

## What Changes

- 新增测试事务管理器：每个 `Deno.test` 用例在一个数据库事务中执行，用例结束统一 `ROLLBACK`。
- 新增 `tests/preload.ts`，通过 `deno test --preload` 全局包装 `Deno.test`，自动为用例注入事务生命周期。
- 修改 `getDb()`：测试事务内返回 `TestTransactionDb` 代理。
- 新增 Savepoint 代理层：服务层 `db.transaction()` 在测试事务内转为 `SAVEPOINT / RELEASE / ROLLBACK TO`，兼容现有 15+ 处嵌套事务调用。
- 修改 `resetDbForTest()`：在测试事务内直接返回（no-op），模块级 reset 保持现有行为。
- 支持 PGlite 与 PostgreSQL 两种模式；纯单元测试惰性开启事务，零额外开销。
- 提供文件级 opt-out：`disableTestTransactionForFile()` 供存在跨用例依赖的测试文件使用。

## Capabilities

### New Capabilities

- `test-transaction-isolation`: 覆盖 noj-core 测试事务回滚隔离能力，包括 preload 包装、惰性事务、Savepoint 代理、reset no-op 与 opt-out。

### Modified Capabilities

- `pglite-test-infrastructure`: 更新 `getDb()` / `resetDbForTest()` 在测试事务下的行为要求。

## Impact

- 修改文件：`noj-core/src/db/connection.ts`、`noj-core/deno.json`、`scripts/test-parallel.ts`，新增 `noj-core/tests/preload.ts`。
- 可能需调整少量存在跨用例依赖的测试文件（使用 opt-out）。
- 不改变生产代码行为；业务 service 层零改动。
- 依赖：继续使用现有 Deno / PGlite / postgres.js，无新增外部依赖。
