## 1. 代码删除与重构（noj-judge）

- [x] 1.1 删除 `noj-judge/src/pool/` 目录（`mod.rs` / `copy.rs` / `exec.rs`，含约 1056 行起的单元测试；`copy.rs` 的 tar+exec 注入已被 `dual/mod.rs` 自带实现替代，无需迁移）
- [x] 1.2 `lib.rs` 移除 `pub mod pool;` 及模块文档中相关描述
- [x] 1.3 `main.rs` 移除：`mod pool;`、`use crate::pool::PoolManager;`、启动日志 `config.pool.max_size`、`POOL_ENABLED` 废弃检测、RPC 镜像白名单拉取（`rpc_client` 构造与 `get_image_allowlist` 调用、`config.pool.images` 回退、`pool::AllowedImage` 构造、`judge_id` / `gethostname` 使用）、`PoolManager::init`、`pool.start_background_tasks()`、优雅关闭中 `pool_ref.shutdown()` 与 `pool_ref` 持有、"等待评测任务（池模式）"文案
- [x] 1.4 `config.rs` 移除：`Config.pool` 字段、`PoolConfig` 结构、`PoolConfig::from_env`、`POOL_*` 环境变量读取（`POOL_INITIAL_SIZE` / `POOL_MAX_SIZE` / `POOL_MIN_SIZE` / `POOL_MEMORY_MB` / `POOL_CPU` / `POOL_IDLE_TIMEOUT` / `POOL_MAX_ARCHIVE_MB` / `POOL_KILL_GRACE_SECONDS` / `POOL_LABEL_PREFIX` / `POOL_IMAGES`）及 `test_config_defaults` / `test_config_custom_values` 中的 pool 断言、`test_pool_max_size_default` / `test_pool_max_size_custom`
- [x] 1.5 注释同步：`src/sandbox/container.rs` 模块注释（"容器生命周期管理全部由 `pool/` 模块负责"→ 双容器 RAII 负责）、`src/sandbox/host_config.rs` 参数注释（"pool containers = true"→ dual 均非只读）、`docker/evaluator-python/Dockerfile` 注释（"由 docker run / pool 加参数"→ 双容器运行时）
- [x] 1.6 依赖清理：确认 `gethostname`（仅用于 RPC judge_id）等依赖在 pool 删除后无其他消费者，从 `Cargo.toml` 移除；`Cargo.lock` 由 cargo 重新生成，勿手改
- [x] 1.7 确认 `mq/rpc.rs` 的 `RpcClient::get_image_allowlist` / `ImageAllowlist` 保留为公共 API（不触发 dead_code），`drain.rs` 排空逻辑保持不变

## 2. 测试与 CI

- [x] 2.1 删除 `noj-judge/tests/e2e_container_pool.rs`（469 行，依赖 `noj_judge::pool::*`）
- [x] 2.2 `.github/workflows/e2e.yml`：`run_group e2e_support_package e2e_problem_limits e2e_container_pool` 移除 `e2e_container_pool`，注释"6 个 e2e_* 测试文件"改为 5 个
- [x] 2.3 `.github/workflows/ci.yml`：judge-e2e 分组同样移除 `e2e_container_pool` 并同步注释

## 3. 文档同步

- [x] 3.1 `noj-judge/CLAUDE.md`：目录结构（main.rs 描述、`pool/` 目录条目）、E2E 测试命令（`e2e_container_pool` 两处）、环境变量表（`POOL_*` 全部 9 项）
- [x] 3.2 根 `AGENTS.md`：§1.1 模块职责表（"容器池（懒回补 + 健康检查）"）、§3 目录树（main.rs / pool/ 目录 / tests 列表）、§5.2 启动顺序（`PoolManager::init`）、§10.1 spec 目录清单（`container-pool/`）、§12.2 E2E 列表
- [x] 3.3 `noj-docs/docs/operators/judge-workers.md`：删除"容器池"一节（含 `POOL_*` 描述与回补/健康检查内容）、简介与水平扩展段落中的容器池表述
- [x] 3.4 `noj-docs/docs/operators/index.md`（"容器池、健康检查"表述）、`noj-docs/docs/operators/local-start.md`（环境变量表 `POOL_INITIAL_SIZE` / `POOL_MAX_SIZE` / `POOL_MEMORY_MB`）

## 4. 验证与验收

- [x] 4.1 `cargo fmt` + `cargo clippy --all-targets` 干净（无 pool 相关警告/未使用依赖警告）
- [x] 4.2 `cargo test --all-targets` 通过（config 测试、dual 单元测试、lib 测试等全绿）
- [x] 4.3 全局无残留：`rg -n "容器池|container pool|PoolManager|POOL_|e2e_container_pool|pool::" noj-judge/ AGENTS.md noj-docs/ openspec/`（排除 `openspec/changes/archive/` 历史归档）无命中
- [x] 4.4 有 Docker 环境时回归：`NOJ_RUN_E2E=1 cargo test --test e2e_dual_container -- --ignored`（双容器评测主路径不受影响）
