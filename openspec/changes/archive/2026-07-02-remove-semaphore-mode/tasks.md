## 1. 环境变量与配置清理

- [x] 1.1 从 `config.rs` 的 `PoolConfig::from_env()` 中移除 `POOL_ENABLED` 环境变量读取
- [x] 1.2 从 `config.rs` 中移除 `MAX_CONCURRENT` 环境变量读取，简化 `Config::max_concurrent()` 为直接返回 `pool.max_size`
- [x] 1.3 在 `config.rs` 中移除 `PoolConfig.enabled` 字段（不再需要）
- [x] 1.4 在 `main.rs` 启动时添加 `POOL_ENABLED` 检测告警：若环境变量被设置（无论值），打印 `warn!` 提示该变量已不再生效

## 2. `main.rs` — 移除 Semaphore 分支

- [x] 2.1 移除 `main.rs` 中的 `Semaphore` use 导入（`use tokio::sync::Semaphore;`）
- [x] 2.2 移除 `main.rs` 中的 `if config.pool.enabled { ... } else { ... }` 分支，仅保留 Pool 模式为主流程（移除整个 `else` 分支约 70 行）
- [x] 2.3 确认 `drain_tasks()` 函数、`FuturesUnordered` 仍被保留（Pool 模式仍使用）

## 3. `runner.rs` — 移除 `evaluate_legacy()`

- [x] 3.1 移除 `judge/runner.rs` 中的 `evaluate_legacy()` 函数（约 117-139 行）
- [x] 3.2 检查 `runner.rs` 中是否有仅 `evaluate_legacy` 使用的 `use` 导入，一并移除（`use std::time::Instant;` 是局部导入已随函数移除；其他公有导入均被 `evaluate_with_pool` 共用）
- [x] 3.3 移除 `judge/mod.rs` 中不再需要的模块导出（无 `evaluate_legacy` re-export，无需变更）
- [x] 3.4 确认 `evaluate_with_pool()` 及其依赖的公共函数（`process_output`、`parse_result_marker`、`JudgeTask` 等）保持不变

## 4. `container.rs` — 移除 Semaphore 独占函数

- [x] 4.1 移除 `run_in_container()` 函数（约 162-324 行）
- [x] 4.2 移除 `ensure_image_local()` 函数（约 326-353 行）
- [x] 4.3 移除 `capture_container_logs()` 函数（约 355-397 行）
- [x] 4.4 在 `PoolManager::init()` 中增强镜像缺失的错误提示，弥补 `ensure_image_local()` 移除后的信息缺失（将镜像名称和构建命令提示写入 `warn!` 日志）
- [x] 4.5 清理 `container.rs` 中的 `use` 导入：移除不再需要的 `bollard::models::ContainerCreateBody`、`bollard::models::HostConfig`、`bollard::container::LogOutput`、`futures_util::StreamExt`、`std::time::Duration` 等
- [x] 4.6 确认保留以下公共函数不变：`prepare_work_dir()`、`get_support_package_bytes()`、`extract_zip()`、`extract_zip_sync()`、`write_user_code()`、`parse_command()`、`ContainerOutput` struct
- [x] 4.7 更新 `container.rs` 模块注释：从"容器生命周期"改为"评测工具函数"

## 5. 测试清理

- [x] 5.1 搜索测试文件中所有对 `evaluate_legacy` 的引用，移除 `tests/e2e_problem_limits.rs`（该测试文件仅测试 evaluate_legacy）
- [x] 5.2 搜索测试文件中所有对 `run_in_container` 的引用，无残留
- [x] 5.3 搜索测试文件中所有对 `ensure_image_local`、`capture_container_logs` 的引用：`e2e_container_pool.rs` 中同名的 `capture_container_logs` 是本地测试辅助函数，与已移除的函数无关
- [x] 5.4 确认 `evaluate_with_pool` 相关的 lib 测试全部通过（42 passed）
- [ ] 5.5 确认 E2E 测试（`e2e_container_pool.rs`、`e2e_docker_basic.rs` 等）全部通过（`NOJ_RUN_E2E=1`）（需要 Docker 环境）

## 6. Spec 文档同步

- [x] 6.1 同步 `openspec/specs/container-pool/spec.md`：移除"池禁用"场景及其 Semaphore 回退描述
- [x] 6.2 同步 `openspec/specs/docker-sandbox/spec.md`：移除 "池预创建容器" 场景中的 `POOL_ENABLED=true` 条件
- [x] 6.3 确认 `openspec/specs/judge-worker/spec.md` 无需变更

## 7. 最终验证

- [x] 7.1 `cargo build` 编译通过（无 warning）
- [x] 7.2 `cargo clippy` 无警告
- [x] 7.3 `cargo fmt --check` 格式正确
- [x] 7.4 `cargo test --lib` 全部通过（42 passed）
- [x] 7.5 确认无残留的 `POOL_ENABLED`、`MAX_CONCURRENT`、`evaluate_legacy`、`run_in_container` 引用（`grep -r` 检查）
