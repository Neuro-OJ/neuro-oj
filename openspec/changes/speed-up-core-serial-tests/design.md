## Context

noj-core 当前测试体系支持两种模式：

- `deno task test`：串行、PGlite 内存库、零外部 PostgreSQL 依赖；
- `deno task test:parallel`：基于真实 PostgreSQL + `TEST_SCHEMA` 的 2 分片并行。

用户选择只优化串行路径，不做并行改造。实测串行主要瓶颈是：

1. 每个测试文件都重新执行 `SCHEMA_DDL`（48 张表）+ `SCHEMA_INDEXES`（84 个索引/物化视图），约 1.2s/文件；
2. 测试默认 bcrypt cost=12，单次哈希约 200ms；
3. `resetDbForTest()` 每次执行全量 `TRUNCATE` + RBAC 重播种 + 物化视图刷新；
4. 少量测试存在真实固定等待（Redis TTL、SSE 超时）。

## Goals / Non-Goals

**Goals:**

- 让 `deno task test` 串行总耗时显著下降。
- 保持零外部 PostgreSQL 依赖，`deno task test` 仍使用 PGlite。
- 保持测试语义不变：每个测试文件仍获得干净数据库状态。
- 改动集中在测试基础设施，不影响生产代码行为。

**Non-Goals:**

- 不引入并行分片、不修改 `test:parallel`、不修改 CI 并行结构。
- 不做事务回滚级测试隔离（侵入大，留待后续）。
- 不优化真实 PostgreSQL 集成测试的并行执行。

## Decisions

### 1. 使用 PGlite 模板缓存消除重复 DDL

**决策**：新增 `scripts/prepare-pglite-template.ts`，构建一次 PGlite 数据目录模板并缓存到 `noj-core/.test-cache/pglite-template-<hash>.tgz`；`connection.ts` 在 PGlite 模式下优先通过 `loadDataDir` 加载模板。

**理由**：

- 实测全量 schema 构建约 1.2s，从模板加载约 0.24s；
- 模板包含 schema + 基础种子，测试文件不再重复执行 DDL；
- `dumpDataDir()` / `loadDataDir` 是 PGlite 原生能力，无新增外部依赖。

**替代方案**：

- 合并测试文件到同一进程共享 PGlite 单例：会破坏现有测试文件模块隔离，风险高，未采用。
- 每次测试用 `dataDir` 文件系统复制：需要磁盘 I/O 且跨平台复杂，未采用。

### 2. 模板 hash 自动失效

**决策**：模板文件名包含内容 hash；hash 来源包括 `SCHEMA_DDL`、`SCHEMA_INDEXES`、种子相关源码文件内容，以及 `PGLITE_TEMPLATE_FORMAT` 常量。测试启动时若模板不存在或 hash 不匹配则自动重建。

**理由**：

- DDL 或种子逻辑变化后无需人工删缓存；
- 首次变更后重建一次约 1.2s，可接受。

**风险缓解**：若间接依赖未纳入 hash，可手动 bump `PGLITE_TEMPLATE_FORMAT` 兜底。

### 3. 测试任务默认 `BCRYPT_SALT_ROUNDS=4`

**决策**：在 `deno.json` 的 `test` / `test:watch` / `test:pg` 任务中注入 `BCRYPT_SALT_ROUNDS=4`。

**理由**：

- 实测 cost=4 单次哈希约 1ms，cost=12 约 200ms；
- CI 已使用 `BCRYPT_SALT_ROUNDS=4`，本地与 CI 保持一致；
- 不改生产代码。

**替代方案**：改为 cost=1 可节省约 1-2ms，但 bcrypt 规范通常要求 cost≥4，且收益可忽略，未采用。

### 4. 优化 `resetDbForTest()`

**决策**：

- PGlite 模式：基于模板后，`ensurePGliteSchemaForTest()` 不再执行 DDL；`resetDbForTest()` 只做 `TRUNCATE + 轻量 seed`。
- postgres.js 模式：不再每次关闭/重建连接池，复用现有连接执行 `TRUNCATE + seed`。
- 将 RBAC 重播种和物化视图刷新从默认 reset 路径中弱化：
  - 保留种子参考表（角色/权限/系统设置），避免每次重插 53 条权限；
  - `user_rankings` 物化视图改为按需刷新，由排名相关测试显式触发。

**理由**：

- 连接池反复关闭/重建是不必要开销；
- RBAC 种子和物化视图刷新并非每个测试都需要；
- 保持 `TRUNCATE` 语义，测试隔离不降低。

**风险缓解**：RBAC 专项测试若需要完整清空种子表，可提供显式的“深度重置”入口。

### 5. 减少固定等待

**决策**：缩短 `revokedTokens` Redis TTL 测试等待、SSE 超时测试等待；必要时引入 fake timers 或更短 TTL。

**理由**：真实 sleep 无法被其他优化消除，属于串行路径中的固定开销。

**风险**：改动测试等待可能影响时序稳定性；通过显式等待条件而非固定 sleep 缓解。

## Risks / Trade-offs

- [模板与 schema 不同步] → 模板 hash 自动失效 + 自动重建。
- [种子逻辑变更未触发 hash 变化] → hash 纳入种子源码文件，并保留手动版本常量兜底。
- [reset 轻量化降低 RBAC 测试隔离] → 提供显式深度重置入口，RBAC 专项测试使用。
- [低 bcrypt cost 降低测试真实性] → 仅测试环境生效，CI 已采用同样配置。
- [固定等待缩短导致偶发 flaky] → 使用轮询/条件等待替代固定 sleep。

## Migration Plan

1. 新增模板构建脚本和 `.test-cache` 忽略规则。
2. 修改 `connection.ts` 支持模板加载与自动重建。
3. 修改 `deno.json` 测试任务注入 `BCRYPT_SALT_ROUNDS=4`。
4. 优化 `resetDbForTest()`。
5. 调整固定等待测试。
6. 运行 `deno task test` 全量回归并对比耗时。

回滚策略：本改动均为测试基础设施局部修改，可单独 revert；模板缓存缺失时自动回退到原 DDL 引导逻辑，保证测试可运行。

## Open Questions

- 是否需要在首个 PR 中包含固定等待优化，还是先只做模板 + bcrypt + reset 三部分？
- RBAC“深度重置”入口的命名与触发方式待实现时确认。
