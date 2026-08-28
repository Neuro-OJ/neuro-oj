## Purpose

定义 noj-core 串行测试性能优化规范，包括 PGlite 模板缓存、低 bcrypt cost 与固定等待最小化。

## Requirements

### Requirement: PGlite 模板缓存

系统 SHALL 在 PGlite 模式下使用预构建模板加载 schema 和基础种子，避免每个测试文件重复执行完整 DDL。

模板 SHALL 由 `scripts/prepare-pglite-template.ts` 构建，包含 `SCHEMA_DDL`、`SCHEMA_INDEXES` 以及基础种子（root 用户、judge image、RBAC）。

模板文件名 SHALL 包含内容 hash；当 DDL 或种子内容变化时，模板 SHALL 自动失效并重建。

当模板缺失或 hash 不匹配时，系统 SHALL 自动重建模板并缓存，或回退到原有 DDL 引导逻辑以保证测试可运行。

#### Scenario: 模板存在时直接加载

- **WHEN** 测试进程启动且 `.test-cache` 中存在匹配当前 hash 的模板
- **THEN** PGlite 实例通过 `loadDataDir` 加载模板，不重复执行 DDL

#### Scenario: 模板缺失时自动重建

- **WHEN** 模板不存在或 hash 不匹配
- **THEN** 系统构建新模板并写入缓存，然后加载该模板

### Requirement: 测试环境低 bcrypt cost

测试任务 SHALL 设置 `BCRYPT_SALT_ROUNDS=4`，使本地测试与 CI 使用一致的较低 bcrypt cost，降低密码哈希/比对耗时。

#### Scenario: deno task test 使用低 cost

- **WHEN** 开发者运行 `deno task test`
- **THEN** 测试进程环境变量 `BCRYPT_SALT_ROUNDS=4` 生效

#### Scenario: test:watch 使用低 cost

- **WHEN** 开发者运行 `deno task test:watch`
- **THEN** 测试进程环境变量 `BCRYPT_SALT_ROUNDS=4` 生效

### Requirement: 固定等待最小化

测试 SHALL 避免不必要的真实固定等待；需要等待异步行为时，SHALL 使用条件轮询、更短 TTL 或显式事件，而不是固定 sleep。

#### Scenario: Redis TTL 测试不固定等待 1.5s

- **WHEN** 测试验证 Redis key 过期行为
- **THEN** 使用更短 TTL 和条件等待，不引入固定 1.5s sleep

#### Scenario: SSE 超时测试不固定等待 1-3s

- **WHEN** 测试验证 SSE 超时或关闭行为
- **THEN** 使用更短超时或立即关闭/推送事件，避免真实等待 1-3 秒
