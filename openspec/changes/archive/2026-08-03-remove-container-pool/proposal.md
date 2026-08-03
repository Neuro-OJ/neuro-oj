## Why

双容器评测架构（Evaluator + Solution）落地后，容器池已无任何消费者：评测路径统一走
`judge::runner::evaluate`（每次即时创建容器），`src/judge/` 与 `src/dual/` 均不引用
pool。当前容器池仍被初始化并空转，仅带来配置噪音（`POOL_*` 环境变量）、无意义的后台
任务开销与维护成本，属于应删除的死代码（issue #199）。

## What Changes

- **BREAKING**：删除 `noj-judge/src/pool/` 目录（`mod.rs` / `copy.rs` / `exec.rs`）。
  经确认 `copy.rs` 的 tar 打包 + docker exec 注入能力已被 `src/dual/mod.rs` 自带的
  `inject_support_package_to_evaluator`（`tar::Builder` + `start_exec`）完全替代，
  无需迁移，随目录一并删除。
- `main.rs` 移除：`mod pool` / `PoolManager` 引用、`PoolManager::init` 初始化、
  `start_background_tasks` 后台任务、优雅关闭中的 `pool_ref.shutdown()`、`POOL_ENABLED`
  废弃检测、启动日志中的 `pool_max_size`、"等待评测任务（池模式）"文案。
- `main.rs` 移除镜像白名单 RPC 拉取（`rpc_client.get_image_allowlist` 及其
  `config.pool.images` 回退、`pool::AllowedImage` 构造）——该调用的唯一消费者是池
  初始化。`mq/rpc.rs` 中的 `RpcClient::get_image_allowlist` 方法与 `ImageAllowlist`
  结构保留（RPC 能力本身与容器池无关，core 侧 handler 继续提供服务）。
- `lib.rs` 移除 `pub mod pool;`。
- `config.rs` 移除 `PoolConfig` 结构、`Config.pool` 字段、`PoolConfig::from_env` 及
  `POOL_INITIAL_SIZE` / `POOL_MAX_SIZE` / `POOL_MIN_SIZE` / `POOL_MEMORY_MB` /
  `POOL_CPU` / `POOL_IDLE_TIMEOUT` / `POOL_MAX_ARCHIVE_MB` / `POOL_KILL_GRACE_SECONDS` /
  `POOL_LABEL_PREFIX` / `POOL_IMAGES` 环境变量读取，连同相关单元测试
  （`test_pool_max_size_default` / `test_pool_max_size_custom` 及默认值/自定义值断言）。
- 注释同步：`src/sandbox/container.rs`（"容器生命周期管理全部由 `pool/` 模块负责"）、
  `src/sandbox/host_config.rs`（"pool containers = true"）、
  `docker/evaluator-python/Dockerfile`（"由 docker run / pool 加参数"）。
- 删除 `tests/e2e_container_pool.rs`（469 行，依赖 `noj_judge::pool::*`）。
- CI：`.github/workflows/e2e.yml` 与 `.github/workflows/ci.yml` 中移除
  `e2e_container_pool` 测试分组，同步更新"6 个 e2e_* 测试文件"注释。
- 文档同步：`noj-judge/CLAUDE.md`（目录结构、E2E 命令、环境变量表）、根 `AGENTS.md`
  （模块职责、目录树、启动顺序、spec 目录清单、E2E 列表）、
  `noj-docs/docs/operators/judge-workers.md`（容器池一节）、
  `noj-docs/docs/operators/index.md`、`noj-docs/docs/operators/local-start.md`
  （环境变量表）。
- `env.e2e.template` 无需修改（其中 `DATABASE_POOL_MAX` 是 PostgreSQL 连接池配置，
  与容器池无关；无 `POOL_*` 变量）。

## Capabilities

### New Capabilities

<!-- 无新增能力 -->

### Modified Capabilities

- `judge-worker`: "评测编排"与"临时文件管理"两个 Requirement 中关于"从池获取容器 /
  释放容器 / 池容器文件注入"的表述更新为双容器即时创建模型。
- `docker-sandbox`: 容器创建模型从"池预创建 + 即时创建双场景"更新为"双容器
  （Evaluator + Solution）每次评测即时创建"，移除 `POOL_MEMORY_MB` 等池化配置描述。
- `judge-rpc`: "judge 使用返回的镜像列表预热容器池"场景更新为 judge 不再拉取白名单
  预热容器池（RPC 方法本身保留）。
- `judge-image-whitelist`: `get_image_allowlist` RPC 的"judge 启动时按 kind 分池预热"
  语义更新为仅作为 core 侧白名单管理能力保留。

## Impact

- **代码**：`noj-judge/src/pool/`（约 1100 行 + copy/exec）、`main.rs` 启动流程、
  `lib.rs`、`config.rs`、`tests/e2e_container_pool.rs`。
- **CI**：`.github/workflows/ci.yml`（judge-e2e 分组）、`.github/workflows/e2e.yml`
  （judge-sandbox 分组）。
- **依赖**：删除 pool 后需确认 `Cargo.toml` 中是否有不再使用的依赖（如 `gethostname`
  仅用于 RPC judge_id、`filetime` 等），以 `cargo check` / `cargo clippy` 结果为准。
- **文档**：`noj-judge/CLAUDE.md`、根 `AGENTS.md`、`noj-docs/docs/operators/*.md`。
- **规范**：`judge-worker` / `docker-sandbox` / `judge-rpc` / `judge-image-whitelist`
  四个 spec 的 delta 更新。
- **对外行为**：judge 启动不再需要 core 的镜像白名单 RPC、不再预热容器；每次评测
  即时创建并销毁容器（与现状评测路径一致，行为无回归）。`POOL_*` 环境变量不再被
  读取（未使用的环境变量不报错，属兼容性无感变更）。
