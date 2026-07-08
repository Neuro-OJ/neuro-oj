## Purpose

定义 noj-judge 集成测试规范，覆盖容器生命周期、资源限制、安全隔离、支持包注入和并发管理，通过真实的 Docker daemon 验证沙箱行为。

## Requirements

### Requirement: 集成测试框架

系统 SHALL 提供一个可门控的集成测试框架，使用真实 Docker daemon 验证 noj-judge
的沙箱功能。

#### Scenario: 测试门控

- **WHEN** 环境变量 `NOJ_RUN_E2E=1` 未设置
- **THEN** 所有集成测试被 `#[ignore]` 标记，`cargo test` 自动跳过

#### Scenario: 测试门控生效

- **WHEN** 设置 `NOJ_RUN_E2E=1`
- **THEN** 所有集成测试运行，使用真实 Docker daemon 创建容器

### Requirement: 测试用 Docker 镜像

系统 SHALL 提供一个专用于集成测试的 Docker 镜像 `noj-judge-test-runner`，基于
`python:3.12-alpine`。

#### Scenario: 镜像构建

- **WHEN** 测试首次运行且镜像不存在
- **THEN** bollard `create_image` 自动构建镜像（从 Dockerfile 或 registry）
- **WHEN** 镜像已存在
- **THEN** 直接使用本地镜像，跳过构建

### Requirement: 容器生命周期测试

系统 SHALL 验证 Docker 容器的完整生命周期：创建 → 启动 → 执行 → 等待 → 日志捕获
→ 清理。

#### Scenario: 正常执行

- **WHEN** 容器内运行 `print(42)`
- **THEN** 容器正常退出（exit_code=0），stdout 包含 "42\n"

#### Scenario: 非零退出码

- **WHEN** 容器内运行 `exit(1)`
- **THEN** 容器以 exit_code=1 退出，stdout 和 stderr 被完整捕获

#### Scenario: 容器清理

- **WHEN** 容器执行完毕
- **THEN** 容器通过 `remove_container` 被移除，临时目录被删除

### Requirement: 超时验证

系统 SHALL 验证容器超时 kill 机制在指定时间限制内生效。

#### Scenario: 超时触发

- **WHEN** 容器内运行 `sleep 60` 且 `time_limit_ms=3000`
- **THEN** 容器在 3 秒 + 5 秒余量内被 kill，返回 exit_code=-1

#### Scenario: 正常任务不超时

- **WHEN** 容器内运行 `print("fast")` 且 `time_limit_ms=10000`
- **THEN** 容器在超时前正常退出，返回 exit_code=0

### Requirement: 内存限制验证

系统 SHALL 验证 Docker 内存限制在超限时触发 OOM kill。

#### Scenario: OOM 触发

- **WHEN** 容器内分配超过 `memory_limit_mb` 的内存
- **THEN** Docker OOM killer 终止进程，容器退出码为 137

#### Scenario: 正常内存使用

- **WHEN** 容器内使用内存低于 `memory_limit_mb`
- **THEN** 容器正常执行完毕

### Requirement: 网络隔离验证

系统 SHALL 验证容器网络被正确禁用（NetworkMode=none）。

#### Scenario: 网络请求被阻止

- **WHEN** 容器内尝试 `requests.get("https://example.com")`
- **THEN** 网络请求失败（连接超时或拒绝）

### Requirement: 支持包注入验证

系统 SHALL 验证支持包解压 + 用户代码写入 + 评测执行的完整流程。

#### Scenario: 带支持包的评测

- **WHEN** 提供包含 `evaluate.py` 的支持包，且写入用户代码 `submission.py`
- **THEN** 容器内执行 `python3 /tmp/evaluate.py`，输出 `---RESULT---` 标记

#### Scenario: 用户代码覆盖模板

- **WHEN** 支持包中包含同名的 `submission.py`（模板文件）
- **THEN** 用户代码覆盖支持包中的模板文件

### Requirement: CPU 限制验证

系统 SHALL 验证容器 CPU 限制为 1 核。

#### Scenario: CPU 限制生效

- **WHEN** 容器内执行 CPU 密集型计算
- **THEN** 容器使用的 CPU 不超过 1 核（通过 `/sys/fs/cgroup` 或时序测量推断）
