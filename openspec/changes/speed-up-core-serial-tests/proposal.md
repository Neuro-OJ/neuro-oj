## Why

noj-core 的串行测试（`deno task test`，PGlite 零依赖模式）运行缓慢，主要因为每个测试文件都重复执行完整的 PGlite schema DDL、默认 bcrypt cost 过高、`resetDbForTest()` 反复做全量 TRUNCATE + 重播种。开发者本地反馈“单个测试也要 2s 左右”，整体等待时间过长。

## What Changes

- 新增 PGlite 模板缓存：用 `loadDataDir` 加载预构建的 schema + 基础种子，避免每个测试文件重复执行 48 张表 / 84 个索引的 DDL。
- 测试任务默认注入 `BCRYPT_SALT_ROUNDS=4`，降低 bcrypt 哈希/比对耗时（保持 CI 一致）。
- 优化 `resetDbForTest()`：
  - PGlite 模式基于模板后只做 `TRUNCATE + 轻量 seed`；
  - postgres.js 模式不再每次关闭/重建连接池；
  - 将 RBAC 重播种和物化视图刷新从“每次 reset 都执行”改为更轻量/按需。
- 缩短测试中的固定等待（如 Redis TTL 1.5s、SSE 超时等待），减少真实时间开销。
- 不引入并行分片，不改变 CI 并行结构，保持 `deno task test` 零外部依赖。

## Capabilities

### New Capabilities

- `core-test-serial-performance`: 覆盖 noj-core 串行测试性能优化，包括 PGlite 模板缓存、测试环境 bcrypt cost、reset 轻量化与固定等待优化。

### Modified Capabilities

- `pglite-test-infrastructure`: 更新 PGlite 测试基础设施要求——支持从预构建模板加载 schema，调整 `resetDbForTest()` 语义以复用连接并避免重复 DDL。

## Impact

- 修改文件：`noj-core/src/db/connection.ts`、`noj-core/deno.json`、新增 `noj-core/scripts/prepare-pglite-template.ts`、相关测试文件（等待时间优化）。
- 新增 gitignore 缓存目录：`noj-core/.test-cache/`。
- 依赖：继续使用 `@electric-sql/pglite`（`dumpDataDir` / `loadDataDir`），无新增外部服务。
- 不影响生产代码行为，仅影响测试基础设施与测试任务配置。
