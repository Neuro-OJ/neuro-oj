## 1. 新增 `with_container()` 闭包 API

- [x] 1.1 在 `PoolManager` impl 中实现 `with_container()` 方法（`pool/mod.rs`），复用 `acquire_with_pool()` 的三阶段获取逻辑
- [x] 1.2 确保 `with_container()` 在闭包返回后（无论 Ok/Err）调用 `self.release()` 清理容器

## 2. 移除旧 Guard API

- [x] 2.1 删除整个 `ContainerGuard` struct、其 `impl` 块和 `Drop` impl（`pool/mod.rs:269-315`）
- [x] 2.2 删除 `acquire_guarded()` 方法（`pool/mod.rs:535-542`）
- [x] 2.3 删除裸露的 `acquire()` 方法（`pool/mod.rs:519-521'）
- [x] 2.4 清理 `release()` 的文档注释中"被 ContainerGuard 析构时自动调用"等 Guard 残余描述

## 3. 重构 `evaluate_with_pool()` 为 closure 模式

- [x] 3.1 将 `evaluate_with_pool()` 中的 `acquire_guarded()` + `guard.release().await` 替换为 `pool.with_container()` 调用
- [x] 3.2 确认 `do_evaluate_with_pool()` 的参数传递正确（闭包内接收 container_id &str）
- [x] 3.3 移除 Guard 模式相关的注释（如"注意：不能同时调用 pool.release()，否则 in_flight 会被减两次"）

## 4. 新增 `TempDir` RAII Guard

- [x] 4.1 在 `sandbox/container.rs` 中新增 `TempDir` struct，包含 `new()`（目录创建）和 `Drop`（`std::fs::remove_dir_all`）
- [x] 4.2 将 `evaluate_with_pool()` 中的临时目录手动清理替换为 `TempDir` guard
- [x] 4.3 保留 `prepare_work_dir()` 公共函数不变（供 `TempDir::new()` 内部调用）

## 5. 测试覆盖

- [x] 5.1 `cargo test --lib` 全部通过（44 passed，新增 2 个 TempDir 测试）
- [x] 5.2 确认 `ContainerGuard`、`acquire_guarded()`、裸露 `acquire()` 均从代码库中完全移除（`grep -r` 检查）
- [x] 5.3 确认 `TempDir` Drop 正确删除目录（单元测试）
- [ ] 5.4 确认 E2E 测试（`e2e_container_pool.rs` 等）通过（`NOJ_RUN_E2E=1`，需要 Docker 环境）

## 6. 最终验证

- [x] 6.1 `cargo build` 编译通过（零 warning）
- [x] 6.2 `cargo clippy` 无额外警告
- [x] 6.3 `cargo fmt --check` 格式正确
