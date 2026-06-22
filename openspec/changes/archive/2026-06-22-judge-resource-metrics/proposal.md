## 变更概述

为评测结果添加时间 (`time_ms`) 和内存峰值 (`memory_kb`) 字段，当前二者始终为
`null`。

## 动机

### 现状

评测结果中的 `time_ms` 和 `memory_kb` 在 `process_output()` 中硬编码为 `None`：

```rust
JudgeResult {
    ...
    time_ms: None,
    memory_kb: None,
}
```

前端提交结果页展示「耗时 --」「内存 --」，用户无法看到评测的资源消耗。

### 需求

- 精确测量评测脚本 (`evaluate.py`) 的执行时间（μs 精度）
- 精确测量评测脚本的内存峰值（KB 精度）
- 结果通过 `JudgeResult.time_ms` 和 `JudgeResult.memory_kb` 字段返回

## 方案对比

| 方案                             | time 精度 | memory 精度 | 复杂度           |
| -------------------------------- | --------- | ----------- | ---------------- |
| Docker stats 轮询（1s）          | ~1s       | ~MB         | 中               |
| **Instant::now() + cgroup 读取** | **~μs**   | **~KB**     | **低**           |
| /usr/bin/time -v 包裹            | ~ms       | ~KB         | 低（需镜像支持） |

### 选定方案

采用 **Instant::now() + cgroup 读取**：

- **时间**：在 `execute_in_container` 中记录 `Instant::now()` 前后差值
- **内存**：exec 结束后在容器内执行
  `cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes`（cgroup v1）或
  `memory.peak`（cgroup v2）
- 当前池模式容器「用完即删」，cgroup 峰值准确反映单次评测消耗
