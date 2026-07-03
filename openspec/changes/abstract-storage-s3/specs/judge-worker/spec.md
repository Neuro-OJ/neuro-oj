## REMOVED Requirements

### Requirement: Base64 支持包解码

**Reason**: JudgeTask 移除 `support_package_base64` 字段，统一使用 `support_package_url` HTTP 下载。项目处于开发阶段，无需向后兼容。
**Migration**: noj-core 在构建 JudgeTask 时始终填充 `support_package_url`；noj-judge 通过 HTTP GET 下载支持包。

## MODIFIED Requirements

### Requirement: 评测编排

系统 SHALL 依序执行：从池获取容器 → 根据 URL scheme 获取支持包 → 解压 → 写入用户代码 → tar 打包 → docker exec 注入 → docker exec 评测 → 解析输出 → 释放容器。

`JudgeTask.support_package_url` 的 scheme 决定获取方式：
- `http://` 或 `https://` → HTTP GET 下载（S3 presigned URL）
- `storage://local/` → 提取 base64 部分解码（数据自包含在 URL 中）

#### Scenario: 评测成功（S3 presigned URL）

- **WHEN** `JudgeTask.support_package_url` 以 `http://` 或 `https://` 开头
- **WHEN** 系统通过 HTTP GET 成功下载支持包 zip
- **WHEN** docker exec 正常退出且 stdout 包含 `---RESULT---` 标记
- **THEN** 系统解析标记后的 JSON，提取 status / score / details 组装 JudgeResult
- **THEN** 容器被 `docker rm -f` 删除，新容器被创建回补到空闲队列
- **THEN** 评测结果通过 Redis MQ 推送回 noj-core

#### Scenario: 评测成功（local 内嵌 base64）

- **WHEN** `JudgeTask.support_package_url` 为 `storage://local/` 开头
- **WHEN** 系统提取 base64 部分并成功解码为 zip 字节
- **WHEN** docker exec 正常退出且 stdout 包含 `---RESULT---` 标记
- **THEN** 系统解析标记后的 JSON，提取 status / score / details 组装 JudgeResult

#### Scenario: 无支持包时跳过

- **WHEN** `JudgeTask.support_package_url` 不存在或为空
- **THEN** 系统跳过支持包获取和解压步骤，直接写入用户代码
- **THEN** 评测正常进行

#### Scenario: URL 下载失败返回 SystemError

- **WHEN** `JudgeTask.support_package_url` 以 `http://` 或 `https://` 开头但 HTTP 下载失败（连接超时、404、403、DNS 解析失败等）
- **THEN** status 设为 `SystemError`，输出包含下载失败原因
- **THEN** 不进行后续评测步骤

#### Scenario: storage://local/ base64 解码失败返回 SystemError

- **WHEN** `JudgeTask.support_package_url` 以 `storage://local/` 开头
- **WHEN** base64 解码失败（非法的 base64 字符串）
- **THEN** status 设为 `SystemError`，输出包含解码失败原因
- **THEN** 不进行后续评测步骤

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
