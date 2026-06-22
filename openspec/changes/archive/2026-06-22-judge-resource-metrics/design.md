## Context

当前 `JudgeResult` 的 `time_ms` 和 `memory_kb` 字段始终为
`None`，评测结果无法体现资源消耗。

此变更在现有评测流程中嵌入精确的资源测量，不影响评测协议和已有字段。

## Goals / Non-Goals

**Goals:**

- `time_ms` 填充评测脚本执行的 wall-clock 时间（毫秒，μs 精度）
- `memory_kb` 填充评测脚本执行期间的内存峰值（KB）
- 两个字段在 `JudgeResult` 中不再为 `null`
- 旧路径（Semaphore 模式）和池路径均覆盖

**Non-Goals:**

- 修改 Redis MQ 消息结构或 `---RESULT---` 协议
- 修改评测行为或超时/内存限制逻辑
- 运行时全量 CPU/内存曲线（前端暂无展示，留待后续）

## Decisions

### D1: 时间测量

**选择**：在 `execute_in_container` 中用 `std::time::Instant::now()` 记录 exec
前后差值。

```rust
let exec_start = Instant::now();
// ... exec ...
let elapsed_ms = exec_start.elapsed().as_millis_u64();
```

**理由**：

- `Instant` 提供纳秒级精度，取毫秒满足前端展示需求
- 零开销，不改变 Docker API 调用模式
- wall-clock 时间反映用户感知的等待时间

### D2: 内存峰值测量

**选择**：exec 结束后在容器内执行
`cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes`（cgroup v1）或
`memory.peak`（cgroup v2），解析返回峰值。

```rust
pub async fn read_memory_peak_kb(docker: &Docker, container_id: &str) -> Result<u64> {
    // 先试 cgroup v2
    let (out, _, code) = exec_cmd(docker, container_id, &["cat", "/sys/fs/cgroup/memory.peak"]).await?;
    if code == 0, let Ok(bytes) = out.trim().parse() { return Ok(bytes / 1024); }
    // 回退 cgroup v1
    let (out, _, code) = exec_cmd(docker, container_id, &["cat", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"]).await?;
    if code == 0, let Ok(bytes) = out.trim().parse() { return Ok(bytes / 1024); }
    Ok(0)
}
```

**理由**：

- `memory.max_usage_in_bytes` 记录容器启动以来物理内存的**历史峰值**
- 当前容器用完即删（`docker rm -f`），峰值准确反映单次评测
- cgroup 读取在容器内以 `docker exec` 执行，毫秒级完成
- v2 (`memory.peak`) 需要 Linux 6.1+，自动降级到 v1 路径

### D3: JudgeResult 填充

**选择**：在 `process_output` 调用后直接设置 `time_ms` 和 `memory_kb`。

```rust
let mut result = process_output(task, &output);
result.time_ms = Some(time_ms);
result.memory_kb = Some(memory_kb);
```

**理由**：

- `process_output` 保持纯函数不引入 I/O 依赖
- 调用方负责传入测量值，职责清晰

## Risks / Trade-offs

| 风险                                | 影响                     | 缓解                                                         |
| ----------------------------------- | ------------------------ | ------------------------------------------------------------ |
| **容器内无 `cat` 命令**             | 内存读取失败             | 返回 0，不阻塞评测                                           |
| **cgroup v2 无 `memory.peak` 文件** | 读取失败，回退 v1 路径   | 自动降级                                                     |
| **容器内 cgroup 路径不同**          | 默认路径不匹配           | 使用 `findmnt -t cgroup` 探测？不——几乎所有 Linux 发行版一致 |
| **旧路径（Semaphore）未覆盖**       | 池改进了但旧路径仍无数据 | 同样改造 `run_in_container`                                  |
