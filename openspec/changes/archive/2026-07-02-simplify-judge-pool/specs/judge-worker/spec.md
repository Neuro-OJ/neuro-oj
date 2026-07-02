## MODIFIED Requirements

### Requirement: 评测编排

系统 SHALL 依序执行：从池获取容器 → 获取支持包（Base64 解码）→ 解压 → 写入用户代码 → tar 打包 → docker exec 注入 → docker exec 评测 → 解析输出 → 释放容器。

#### Scenario: 评测成功

- **WHEN** 系统从池成功获取空闲容器（或即时创建）
- **WHEN** docker exec 正常退出且 stdout 包含 `---RESULT---` 标记
- **THEN** 系统解析标记后的 JSON，提取 status / score / details 组装 JudgeResult
- **THEN** 容器被 `docker rm -f` 删除，新容器被创建回补到空闲队列
- **THEN** 评测结果通过 Redis MQ 推送回 noj-core

#### Scenario: 评测超时

- **WHEN** exec 运行时间超过 `time_limit_ms + kill_grace_secs × 1000` ms
- **THEN** 系统有序终止（`docker stop -t <kill_grace_secs>` → `docker kill`）
- **THEN** status 设为 `TimeLimitExceeded`，score 设为 0

#### Scenario: 评测脚本无有效输出

- **WHEN** exec 退出但 stdout 中没有 `---RESULT---` 标记，且退出码为 0
- **THEN** status 设为 `SystemError`，output 保留完整 stdout/stderr

#### Scenario: 用户代码运行时错误

- **WHEN** exec 退出但 stdout 中没有 `---RESULT---` 标记，且退出码非 0
- **THEN** status 设为 `RuntimeError`，output 保留完整 stdout/stderr

#### Scenario: 容器内存超限

- **WHEN** 容器因 OOM 被 Docker kill（退出码 137）
- **THEN** status 设为 `MemoryLimitExceeded`，score 设为 0

#### Scenario: 容器创建失败（镜像问题）

- **WHEN** task.judge_image 对应的镜像在本地不存在且拉取失败
- **THEN** 评测返回 SystemError，错误信息包含镜像名和构建提示

#### Scenario: 返回资源消耗数据

- **WHEN** 评测完成（正常或异常）
- **THEN** `JudgeResult.time_ms` 包含评测脚本执行时间（毫秒，μs 精度）
- **THEN** `JudgeResult.memory_kb` 包含评测脚本执行期间的内存峰值（KB）
- **WHEN** 资源测量失败（如 cgroup 不可读）
- **THEN** `time_ms` 和 `memory_kb` 返回 0

#### Scenario: 临时目录在错误时仍清理

- **WHEN** 评测过程中发生错误（超时、OOM 等）
- **THEN** 临时目录及其内容仍被删除

### Requirement: 并发控制

系统 SHALL 通过固定大小容器池控制并发评测数。

#### Scenario: 无空闲容器时即时创建

- **WHEN** 空闲队列为空
- **THEN** 系统即时创建新容器并分配
- **THEN** 池中 InUse 容器数不超过 `POOL_MAX_SIZE`

#### Scenario: 并发任务完成释放

- **WHEN** 某个评测任务完成（无论成功或失败）
- **THEN** `in_flight` 计数器 -1，容器被删除
- **THEN** 新容器被创建并回补到空闲队列
