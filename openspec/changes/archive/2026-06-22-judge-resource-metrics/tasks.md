## 1. 时间测量

- [x] 1.1 修改 `execute_in_container`：函数开始时记录
      `Instant::now()`，返回时添加 `elapsed.as_millis_u64()`，签名从
      `-> Result<(String, String, i64)>` 改为
      `-> Result<(String, String, i64, u64)>`
- [x] 1.2 更新 `pool/exec.rs` 中的超时路径：超时场景也返回
      `(output, String::new(), -1, timeout_ms)`，确保 `time_ms` 始终有值

## 2. 内存峰值测量

- [x] 2.1 在 `pool/exec.rs` 中新增
      `read_memory_peak_kb(docker, container_id) -> Result<u64>` 函数
- [x] 2.2 实现 cgroup v2 (`memory.peak`) → v1 (`memory.max_usage_in_bytes`)
      自动降级

## 3. 评测编排填充结果

- [x] 3.1 修改 `judge/runner.rs` 的 `do_evaluate_with_pool`：在
      `execute_in_container` 后调用 `read_memory_peak_kb`，填充 `result.time_ms`
      和 `result.memory_kb`
- [x] 3.2 修改 `sandbox/container.rs` 的 `ContainerOutput` 和
      `run_in_container`：旧路径同样收集 `time_ms` 和 `memory_kb`

## 4. 文档与规范

- [x] 4.1 更新 `openspec/specs/docker-sandbox/spec.md`：新增资源测量 Requirement
- [x] 4.2 更新 `openspec/specs/judge-worker/spec.md`：更新 JudgeResult 字段说明
- [x] 4.3 更新 `openspec/changes/judge-container-pool/design.md`：在 D3
      中说明时间测量集成
